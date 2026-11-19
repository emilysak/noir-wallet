import type { ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import type { AssetRegistry, ChainRegistry } from '@/core/chains/registry'
import type {
  PortfolioReadErrorCode,
  PortfolioSourceSnapshot,
  PortfolioSourceStatus
} from '@/core/portfolio'
import type { StorageV2GenerationId } from '@/ports/repositories'
import type {
  ActiveBitcoinDiscoveryContext,
  BitcoinDiscoveryCoordinator,
  BitcoinDiscoveryStorageRepository
} from './bitcoin-discovery-coordinator'
import type { BitcoinDiscoveryState } from './bitcoin-discovery-repository'
import { BitcoinDiscoveryError } from './bitcoin-gap-limit-scanner'
import type { BitcoinInputReservationRepository } from './bitcoin-input-reservation-model'
import {
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType,
  type BitcoinUtxo
} from '@/core/chains/bitcoin'
import { BitcoinRpcError } from './bitcoin-esplora-client'
import {
  bitcoinDiscoveryAddressTypeComplete,
  loadActiveBitcoinDiscoveryContext
} from './bitcoin-discovery-coordinator'
import { isFixedSingleAddressBitcoinCheckpoint } from './bitcoin-discovery-persistence-model'
import {
  isActiveBitcoinAddressObservation,
  isLedgerBitcoinAccountObservation
} from './bitcoin-spendable-utxos'
import { bitcoinAccountRootFromPath } from './bitcoin-transaction-model'

export interface ActiveBitcoinPortfolioSource {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly source: PortfolioSourceSnapshot
}

export interface BitcoinPortfolioCoordinatorOptions {
  readonly storageRepository: BitcoinDiscoveryStorageRepository
  readonly discovery: Pick<BitcoinDiscoveryCoordinator, 'readCachedActive' | 'scanActive'>
  readonly inputReservations: Pick<BitcoinInputReservationRepository, 'list'>
  readonly chainId: string
  readonly chains: ChainRegistry
  readonly assets: AssetRegistry
  readonly getAddressType?: (
    context: ActiveBitcoinDiscoveryContext
  ) => Promise<BitcoinSupportedAddressType>
  // Reads the account-network PEA when another component has already exposed it.
  readonly resolvePrivateExecutionAddress?: (
    context: ActiveBitcoinDiscoveryContext
  ) => Promise<string | undefined>
  // One address lookup. This must not scan a gap or a change chain.
  readonly readPrivateAddressUtxos?: (address: string) => Promise<readonly BitcoinUtxo[]>
  readonly onRefreshError?: (
    error: unknown,
    context: ActiveBitcoinDiscoveryContext
  ) => Promise<void> | void
}

export const BITCOIN_PORTFOLIO_STAGES = Object.freeze([
  'active-context',
  'discovery-cache',
  'active-pointer',
  'source-model'
] as const)

export type BitcoinPortfolioStage = (typeof BITCOIN_PORTFOLIO_STAGES)[number]

export class BitcoinPortfolioCoordinatorError extends Error {
  readonly stage: BitcoinPortfolioStage
  readonly cause: unknown

  constructor(stage: BitcoinPortfolioStage, cause: unknown) {
    super(`Bitcoin Portfolio ${stage} operation failed`)
    this.name = 'BitcoinPortfolioCoordinatorError'
    this.stage = stage
    this.cause = cause
  }
}

async function atBitcoinPortfolioStage<T>(
  stage: BitcoinPortfolioStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof BitcoinPortfolioCoordinatorError) throw error
    throw new BitcoinPortfolioCoordinatorError(stage, error)
  }
}

function mapError(error: unknown): PortfolioReadErrorCode {
  if (error instanceof BitcoinRpcError) {
    if (error.code === 'rate-limited') return 'rate-limited'
    if (error.code === 'unauthorized') return 'unauthorized'
    if (error.code === 'invalid-response' || error.code === 'chain-mismatch') {
      return 'invalid-response'
    }
    if (error.code === 'network-unavailable' || error.code === 'timeout') {
      return 'network-unavailable'
    }
  }
  if (error instanceof BitcoinDiscoveryError && error.code === 'rpc-failure') {
    return 'network-unavailable'
  }
  return 'unknown'
}

function outpointKey(transactionId: string, outputIndex: number): string {
  return `${transactionId}:${outputIndex}`
}

const DEFAULT_BITCOIN_ACCOUNT_TYPE = 'p2wpkh'

export class BitcoinPortfolioCoordinator {
  private readonly chainId: ChainId

  constructor(private readonly options: BitcoinPortfolioCoordinatorOptions) {
    const chain = options.chains.resolve(options.chainId)
    if (chain.family !== 'bitcoin') {
      throw new Error('Bitcoin Portfolio coordinator requires a Bitcoin chain')
    }
    const assets = options.assets.list(chain.id)
    if (
      assets.length !== 1 ||
      assets[0].asset.kind !== 'native' ||
      assets[0].asset.namespace !== 'slip44' ||
      assets[0].asset.reference !== '0'
    ) {
      throw new Error('Bitcoin Portfolio coordinator requires the trusted BTC asset')
    }
    this.chainId = chain.id
  }

  async readCachedActiveSource(): Promise<ActiveBitcoinPortfolioSource | null> {
    const context = await atBitcoinPortfolioStage('active-context', () => this.loadActiveContext())
    if (!context) return null
    const state = await atBitcoinPortfolioStage('discovery-cache', () =>
      this.options.discovery.readCachedActive()
    )
    if (
      !(await atBitcoinPortfolioStage('active-pointer', () => this.contextRemainsActive(context)))
    ) {
      return null
    }
    if (state && state.chainAccount.id !== context.chainAccount.id) {
      throw new Error('Bitcoin Portfolio discovery does not match the active ChainAccount')
    }
    const addressType = await this.resolveAddressType(context)
    const source = await atBitcoinPortfolioStage('source-model', () =>
      this.createSource(
        context,
        state,
        this.discoveryComplete(context, state, addressType) ? 'ready' : 'loading',
        addressType
      )
    )
    return Object.freeze({ ...context, source })
  }

  async refreshActiveSource(
    options: Readonly<{ requireNewScan?: boolean }> = {}
  ): Promise<ActiveBitcoinPortfolioSource | null> {
    const context = await atBitcoinPortfolioStage('active-context', () => this.loadActiveContext())
    if (!context) return null
    try {
      const cached = await atBitcoinPortfolioStage('discovery-cache', () =>
        this.options.discovery.readCachedActive()
      )
      const addressType = await this.resolveAddressType(context)
      const forceRefresh = await atBitcoinPortfolioStage('discovery-cache', () =>
        this.hasCommittedInputStillCached(context, cached, addressType)
      )
      const state = await this.options.discovery.scanActive({
        forceRefresh: forceRefresh || options.requireNewScan === true,
        requireNewScan: options.requireNewScan,
        addressType
      })
      if (
        !state ||
        !(await atBitcoinPortfolioStage('active-pointer', () => this.contextRemainsActive(context)))
      ) {
        return null
      }
      if (state.chainAccount.id !== context.chainAccount.id) {
        throw new Error('Bitcoin Portfolio discovery does not match the active ChainAccount')
      }
      const source = await atBitcoinPortfolioStage('source-model', () =>
        this.createSource(
          context,
          state,
          this.discoveryComplete(context, state, addressType) ? 'ready' : 'loading',
          addressType
        )
      )
      return Object.freeze({ ...context, source })
    } catch (error) {
      await Promise.resolve(this.options.onRefreshError?.(error, context)).catch(() => {})
      if (
        !(await atBitcoinPortfolioStage('active-pointer', () => this.contextRemainsActive(context)))
      ) {
        return null
      }
      const state = await atBitcoinPortfolioStage('discovery-cache', () =>
        this.options.discovery.readCachedActive()
      )
      if (state && state.chainAccount.id !== context.chainAccount.id) {
        throw new Error('Bitcoin Portfolio discovery does not match the active ChainAccount')
      }
      const addressType = await this.resolveAddressType(context)
      const source = await atBitcoinPortfolioStage('source-model', () =>
        this.createSource(context, state, 'error', addressType, mapError(error))
      )
      return Object.freeze({ ...context, source })
    }
  }

  private async createSource(
    context: ActiveBitcoinDiscoveryContext,
    state: BitcoinDiscoveryState | null,
    status: PortfolioSourceStatus,
    addressType: BitcoinSupportedAddressType,
    errorCode?: PortfolioReadErrorCode
  ): Promise<PortfolioSourceSnapshot> {
    const asset = this.options.assets.list(this.chainId)[0]
    const privateAddress = await this.readPrivateExecutionAddress(context)
    if (!state) {
      const privateRaw = await this.readPrivateRaw(privateAddress)
      return Object.freeze({
        chainAccount: context.chainAccount,
        status,
        balances: Object.freeze([
          this.balanceSnapshot(asset.asset.id, 0n, 0n, 0n, 0n, 0, privateRaw)
        ]),
        ...(errorCode === undefined ? {} : { errorCode })
      })
    }
    const unavailable = new Set<string>()
    for (const reservation of await this.options.inputReservations.list({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex,
      addressType
    })) {
      for (const outpoint of reservation.outpoints) {
        unavailable.add(outpointKey(outpoint.transactionId, outpoint.outputIndex))
      }
    }
    const seen = new Set<string>()
    let total = 0n
    let spendable = 0n
    let available = 0n
    let pending = 0n
    const ledgerRoot = this.ledgerAccountRoot(context)
    const privateRaw = await this.readPrivateRaw(privateAddress)
    for (const observation of state.observations) {
      if (privateAddress !== undefined && observation.derived.address === privateAddress) continue
      if (
        ledgerRoot === undefined
          ? !isActiveBitcoinAddressObservation(observation, addressType)
          : observation.derived.addressType !== addressType ||
            !isLedgerBitcoinAccountObservation(observation, ledgerRoot)
      )
        continue
      for (const utxo of observation.utxos) {
        const key = outpointKey(utxo.transactionId, utxo.outputIndex)
        if (seen.has(key)) throw new Error('Duplicate Bitcoin Portfolio UTXO')
        seen.add(key)
        const value = BigInt(utxo.valueRaw)
        total += value
        if (utxo.status.confirmed) {
          spendable += value
          if (!unavailable.has(key)) available += value
        } else {
          pending += value
        }
      }
    }
    return Object.freeze({
      chainAccount: context.chainAccount,
      status,
      balances: Object.freeze([
        this.balanceSnapshot(
          asset.asset.id,
          total,
          spendable,
          available,
          pending,
          state.updatedAt,
          privateRaw
        )
      ]),
      ...(errorCode === undefined ? {} : { errorCode })
    })
  }

  private balanceSnapshot(
    assetId: string,
    publicTotal: bigint,
    spendable: bigint,
    available: bigint,
    pending: bigint,
    updatedAt: number,
    privateRaw: bigint | undefined
  ) {
    // mainRaw is the public-address total. privateRaw is only the PEA.
    // The portfolio balance type requires totalRaw to be their sum.
    const split = privateRaw !== undefined
    return Object.freeze({
      assetId,
      totalRaw: (split ? publicTotal + privateRaw : publicTotal).toString(),
      ...(split ? { mainRaw: publicTotal.toString(), privateRaw: privateRaw.toString() } : {}),
      spendableRaw: spendable.toString(),
      availableRaw: available.toString(),
      pendingRaw: pending.toString(),
      updatedAt
    })
  }

  private async readPrivateExecutionAddress(
    context: ActiveBitcoinDiscoveryContext
  ): Promise<string | undefined> {
    if (context.keyDomainSource.kind === 'hardware') return undefined
    const resolve = this.options.resolvePrivateExecutionAddress
    if (!resolve || !this.options.readPrivateAddressUtxos) return undefined
    try {
      const address = await resolve(context)
      if (!address) return undefined
      return parseSupportedBitcoinAddress(address, this.chainId, 'p2wpkh')
    } catch {
      return undefined
    }
  }

  private async readPrivateRaw(address: string | undefined): Promise<bigint | undefined> {
    if (!address) return undefined
    const read = this.options.readPrivateAddressUtxos
    if (!read) return undefined
    try {
      const utxos = await read(address)
      const seen = new Set<string>()
      let total = 0n
      for (const utxo of utxos) {
        const key = outpointKey(utxo.transactionId, utxo.outputIndex)
        if (seen.has(key)) throw new Error('Duplicate Bitcoin Portfolio UTXO')
        seen.add(key)
        total += BigInt(utxo.valueRaw)
      }
      return total
    } catch {
      // A PEA lookup failure leaves the public discovery total unchanged.
      return undefined
    }
  }

  private loadActiveContext(): Promise<ActiveBitcoinDiscoveryContext | null> {
    return loadActiveBitcoinDiscoveryContext(this.options.storageRepository, this.chainId)
  }

  private async hasCommittedInputStillCached(
    context: ActiveBitcoinDiscoveryContext,
    state: BitcoinDiscoveryState | null,
    addressType: BitcoinSupportedAddressType
  ): Promise<boolean> {
    if (!state) return false
    const ledgerRoot = this.ledgerAccountRoot(context)
    const cachedOutpoints = new Set(
      state.observations
        .filter(observation =>
          ledgerRoot === undefined
            ? isActiveBitcoinAddressObservation(observation, addressType)
            : observation.derived.addressType === addressType &&
              isLedgerBitcoinAccountObservation(observation, ledgerRoot)
        )
        .flatMap(observation =>
          observation.utxos.map(utxo => outpointKey(utxo.transactionId, utxo.outputIndex))
        )
    )
    if (cachedOutpoints.size === 0) return false
    const reservations = await this.options.inputReservations.list({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex,
      addressType
    })
    return reservations.some(
      reservation =>
        reservation.state === 'committed' &&
        reservation.outpoints.some(outpoint =>
          cachedOutpoints.has(outpointKey(outpoint.transactionId, outpoint.outputIndex))
        )
    )
  }

  private resolveAddressType(
    context: ActiveBitcoinDiscoveryContext
  ): Promise<BitcoinSupportedAddressType> {
    return this.options.getAddressType
      ? this.options.getAddressType(context)
      : Promise.resolve(DEFAULT_BITCOIN_ACCOUNT_TYPE)
  }

  private ledgerAccountRoot(context: ActiveBitcoinDiscoveryContext): string | undefined {
    return context.keyDomainSource.kind === 'hardware' &&
      context.keyDomainSource.vendor === 'ledger'
      ? bitcoinAccountRootFromPath(
          context.chainAccount.derivation.path,
          this.chainId,
          'p2wpkh',
          false,
          0
        )
      : undefined
  }

  private discoveryComplete(
    context: ActiveBitcoinDiscoveryContext,
    state: BitcoinDiscoveryState | null,
    addressType: BitcoinSupportedAddressType
  ): boolean {
    return Boolean(
      state &&
      bitcoinDiscoveryAddressTypeComplete(state, addressType) &&
      (this.ledgerAccountRoot(context) === undefined ||
        !isFixedSingleAddressBitcoinCheckpoint(state.checkpoint))
    )
  }

  private async contextRemainsActive(context: ActiveBitcoinDiscoveryContext): Promise<boolean> {
    const pointer = await this.options.storageRepository.getActivePointer()
    return pointer?.generationId === context.generationId
  }
}
