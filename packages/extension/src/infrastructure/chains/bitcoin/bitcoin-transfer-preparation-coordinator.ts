import { address, networks, Transaction } from 'bitcoinjs-lib'
import type { BitcoinSupportedAddressType, BitcoinUtxo } from '@/core/chains/bitcoin'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import type { BitcoinAddressDerivationPort } from '@/infrastructure/keyring/multichain/bitcoin-derivation-client'
import type { BitcoinChangeReservation } from './bitcoin-change-reservation-model'
import type { BitcoinChangeReservationCoordinator } from './bitcoin-change-reservation-coordinator'
import { selectBitcoinCoins, selectBitcoinFeeRate } from './bitcoin-coin-selection'
import type { BitcoinDiscoveryRpc, BitcoinTransactionRpc } from './bitcoin-esplora-client'
import {
  bitcoinChainAccountsMatch,
  hasExactKeys,
  isRecord,
  parseCheckpoint,
  parseScope,
  parseTimestamp,
  type BitcoinDiscoveryRepository,
  type BitcoinDiscoveryScope
} from './bitcoin-discovery-persistence-model'
import { parseObservation } from './bitcoin-discovery-persistence-observation'
import {
  parseBitcoinInputReservation,
  type BitcoinInputReservation,
  type BitcoinInputReservationRepository
} from './bitcoin-input-reservation-model'
import { buildBitcoinPrivateExecutionPsbt, buildBitcoinPsbt } from './bitcoin-psbt-builder'
import { collectBitcoinSpendableUtxos } from './bitcoin-spendable-utxos'
import {
  BITCOIN_DEFAULT_FEE_TARGET_BLOCKS,
  BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS,
  bitcoinAccountRootFromPath,
  BITCOIN_MAINNET_CHAIN_ID,
  parseBitcoinAddress,
  parseBitcoinAddressType,
  parseBitcoinChain,
  parseBitcoinIndex,
  parseBitcoinFeeRate,
  parseBitcoinMasterFingerprint,
  parseBitcoinPublicKey,
  parseBitcoinTransferAmount,
  type BitcoinChangeOutputPosition,
  type BitcoinCoinSelection,
  type BitcoinFeeRateQuote,
  type BitcoinTransferAmount,
  type PreparedBitcoinPsbt
} from './bitcoin-transaction-model'

export interface BitcoinTransferPreparationRpc
  extends
    Pick<BitcoinDiscoveryRpc, 'assertExpectedChain' | 'getTipHeight' | 'getAddressUtxos'>,
    Pick<BitcoinTransactionRpc, 'getFeeEstimates' | 'getRawTransaction'> {}

export interface BitcoinTransferPreparationCoordinatorOptions {
  readonly discoveryRepository: Pick<BitcoinDiscoveryRepository, 'get'>
  readonly derivation: BitcoinAddressDerivationPort
  readonly rpc: BitcoinTransferPreparationRpc
  readonly inputReservations: Pick<
    BitcoinInputReservationRepository,
    'list' | 'reserve' | 'release'
  >
  readonly changeReservations?: Pick<BitcoinChangeReservationCoordinator, 'reserve' | 'abandon'>
  readonly now?: () => number
  readonly selectChangeOutputPosition?: (
    transactionId: TransactionId
  ) => Promise<BitcoinChangeOutputPosition> | BitcoinChangeOutputPosition
}

export interface PrepareBitcoinTransferFromDiscoveryInput extends BitcoinDiscoveryScope {
  readonly transactionId: TransactionId
  readonly addressType: BitcoinSupportedAddressType
  readonly recipient: string
  readonly amount: BitcoinTransferAmount
  readonly feeTargetBlocks?: number
  readonly feeRateSatsPerVbyte?: number
  readonly signal?: AbortSignal
  readonly ledgerAccount?: boolean
}

export interface PrepareBitcoinPrivateTransferInput extends BitcoinDiscoveryScope {
  readonly transactionId: TransactionId
  readonly recipient: string
  readonly amount: BitcoinTransferAmount
  readonly privateExecutionAddress?: string
  readonly publicKey: string
  readonly publicReceiveAddress: string
  readonly feeTargetBlocks?: number
  readonly feeRateSatsPerVbyte?: number
  readonly signal?: AbortSignal
}

export interface PreparedBitcoinTransferPlan {
  readonly transactionId: TransactionId
  readonly signerAddress: string
  readonly feeRate: BitcoinFeeRateQuote
  readonly selection: BitcoinCoinSelection
  readonly inputReservation: BitcoinInputReservation
  readonly changeReservation: BitcoinChangeReservation | null
  readonly prepared: PreparedBitcoinPsbt
  readonly discoveryUpdatedAt: number
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Bitcoin transfer preparation was cancelled')
}

function spentOutputAddress(
  rawTransactionHex: string,
  outputIndex: number,
  network: typeof networks.bitcoin
): string {
  let transaction: Transaction
  try {
    transaction = Transaction.fromHex(rawTransactionHex)
  } catch {
    throw new Error('Bitcoin private transfer input is not the private execution address')
  }
  const output = transaction.outs[outputIndex]
  if (!output) {
    throw new Error('Bitcoin private transfer input is not the private execution address')
  }
  try {
    return address.fromOutputScript(output.script, network)
  } catch {
    throw new Error('Bitcoin private transfer input is not the private execution address')
  }
}

function assertDiscoveryComplete(
  cursors: ReturnType<typeof parseCheckpoint>['cursors'],
  addressType: BitcoinSupportedAddressType,
  ledgerAccount: boolean
): void {
  const selected = cursors.filter(cursor => cursor.target.addressType === addressType)
  const receive = selected.find(cursor => !cursor.target.change)
  if (!receive?.complete) {
    throw new Error('Bitcoin receive address discovery must complete before spending')
  }
  if (ledgerAccount && !selected.find(cursor => cursor.target.change)?.complete) {
    throw new Error('Ledger Bitcoin change address discovery must complete before spending')
  }
}

function inputOutpoints(selection: BitcoinCoinSelection) {
  return Object.freeze(
    selection.selectedUtxos.map(utxo =>
      Object.freeze({ transactionId: utxo.transactionId, outputIndex: utxo.outputIndex })
    )
  )
}

async function defaultChangeOutputPosition(
  transactionId: TransactionId
): Promise<BitcoinChangeOutputPosition> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transactionId))
  return new Uint8Array(digest)[0] % 2 === 0 ? 'first' : 'last'
}

export class BitcoinTransferPreparationCoordinator {
  constructor(private readonly options: BitcoinTransferPreparationCoordinatorOptions) {}

  async prepare(
    input: PrepareBitcoinTransferFromDiscoveryInput
  ): Promise<PreparedBitcoinTransferPlan> {
    if (
      !isRecord(input) ||
      !hasExactKeys(
        input,
        ['chainAccount', 'accountIndex', 'transactionId', 'addressType', 'recipient', 'amount'],
        ['feeTargetBlocks', 'feeRateSatsPerVbyte', 'signal', 'ledgerAccount']
      ) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      throw new Error('Invalid Bitcoin transfer preparation input')
    }
    const scope = parseScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex
    })
    const transactionId = parseTransactionId(input.transactionId)
    const chainId = parseBitcoinChain(scope.chainAccount.scope.chainId)
    const addressType = parseBitcoinAddressType(input.addressType)
    const recipient = parseBitcoinAddress(input.recipient, chainId)
    const amount = parseBitcoinTransferAmount(input.amount)
    const ledgerAccount = input.ledgerAccount === true
    if (input.ledgerAccount !== undefined && typeof input.ledgerAccount !== 'boolean') {
      throw new Error('Invalid Ledger Bitcoin account selection')
    }
    if (ledgerAccount && addressType !== 'p2wpkh') {
      throw new Error('Ledger Bitcoin transfer requires Native SegWit')
    }
    const ledgerRoot = ledgerAccount
      ? bitcoinAccountRootFromPath(scope.chainAccount.derivation.path, chainId, 'p2wpkh', false, 0)
      : undefined
    if (input.feeTargetBlocks !== undefined && input.feeRateSatsPerVbyte !== undefined) {
      throw new Error('Bitcoin fee target and explicit fee rate are mutually exclusive')
    }
    const feeTargetBlocks = parseBitcoinIndex(
      input.feeTargetBlocks ?? BITCOIN_DEFAULT_FEE_TARGET_BLOCKS,
      'Bitcoin fee target',
      BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS
    )
    if (feeTargetBlocks === 0) throw new Error('Invalid Bitcoin fee target')
    const explicitFeeRate =
      input.feeRateSatsPerVbyte === undefined
        ? undefined
        : parseBitcoinFeeRate(input.feeRateSatsPerVbyte)
    assertNotCancelled(input.signal)

    const state = await this.options.discoveryRepository.get(scope)
    if (state === null) {
      throw new Error('Bitcoin discovery must complete before spending')
    }
    const storedScope = parseScope({
      chainAccount: state.chainAccount,
      accountIndex: state.accountIndex
    })
    if (!bitcoinChainAccountsMatch(storedScope.chainAccount, scope.chainAccount)) {
      throw new Error('Bitcoin discovery does not match the selected ChainAccount')
    }
    const checkpoint = parseCheckpoint(state.checkpoint, scope)
    const discoveryUpdatedAt = parseTimestamp(state.updatedAt)
    assertDiscoveryComplete(checkpoint.cursors, addressType, ledgerAccount)
    const observations = state.observations.map(value => parseObservation(value, scope))
    const signer = observations.find(
      observation =>
        observation.derived.addressType === addressType &&
        !observation.derived.change &&
        observation.derived.addressIndex === 0
    )?.derived.address
    if (signer === undefined) {
      throw new Error('Bitcoin signer address is missing from discovery')
    }
    if (addressType === 'p2wpkh' && signer !== scope.chainAccount.identity.value) {
      throw new Error('Bitcoin signer address does not match the selected ChainAccount')
    }

    assertNotCancelled(input.signal)
    const derivedSigner = await this.options.derivation.deriveAddress(
      scope.chainAccount.scope.keyDomainId,
      {
        chainId,
        addressType,
        accountIndex: scope.accountIndex,
        change: false,
        addressIndex: 0
      },
      input.signal
    )
    if (ledgerAccount && derivedSigner.derivationPath !== scope.chainAccount.derivation.path) {
      throw new Error('Ledger Bitcoin signer path does not match the selected account')
    }
    if (derivedSigner.address !== signer) {
      throw new Error(
        ledgerAccount
          ? 'Ledger Bitcoin signer does not match discovery'
          : 'WASM-derived Bitcoin signer does not match discovery'
      )
    }
    const masterFingerprint = parseBitcoinMasterFingerprint(derivedSigner.masterFingerprint)

    assertNotCancelled(input.signal)
    await this.options.rpc.assertExpectedChain(input.signal)
    const [tipHeight, feeEstimates] = await Promise.all([
      this.options.rpc.getTipHeight(input.signal),
      explicitFeeRate === undefined
        ? this.options.rpc.getFeeEstimates(input.signal)
        : Promise.resolve(null)
    ])
    assertNotCancelled(input.signal)
    const feeRate =
      explicitFeeRate === undefined
        ? selectBitcoinFeeRate(feeEstimates, feeTargetBlocks)
        : Object.freeze({
            requestedTargetBlocks: feeTargetBlocks,
            sourceTargetBlocks: feeTargetBlocks,
            satsPerVbyte: explicitFeeRate
          })
    const unavailableOutpoints = new Set(
      (await this.options.inputReservations.list({ ...scope, addressType }))
        .filter(reservation => reservation.transactionId !== transactionId)
        .flatMap(reservation =>
          reservation.outpoints.map(outpoint => `${outpoint.transactionId}:${outpoint.outputIndex}`)
        )
    )
    const utxos = collectBitcoinSpendableUtxos(observations, addressType, ledgerRoot).filter(
      utxo => !unavailableOutpoints.has(`${utxo.transactionId}:${utxo.outputIndex}`)
    )
    if (utxos.some(utxo => utxo.blockHeight > tipHeight)) {
      throw new Error('Bitcoin discovery contains a UTXO above the current tip')
    }
    const selection = selectBitcoinCoins({
      chainId,
      accountIndex: scope.accountIndex,
      addressType,
      recipient,
      amount,
      feeRateSatsPerVbyte: feeRate.satsPerVbyte,
      utxos
    })
    const previousTransactions =
      addressType === 'p2tr'
        ? undefined
        : await Promise.all(
            [...new Set(selection.selectedUtxos.map(utxo => utxo.transactionId))].map(
              async transactionId =>
                Object.freeze({
                  transactionId,
                  rawTransactionHex: await this.options.rpc.getRawTransaction(
                    transactionId,
                    input.signal
                  )
                })
            )
          )
    assertNotCancelled(input.signal)

    let inputReservation: BitcoinInputReservation | null = null
    let changeReservation: BitcoinChangeReservation | null = null
    try {
      const reservedInputs = parseBitcoinInputReservation(
        await this.options.inputReservations.reserve({
          ...scope,
          addressType,
          transactionId,
          outpoints: inputOutpoints(selection),
          now: this.timestamp()
        }),
        { ...scope, addressType },
        transactionId
      )
      if (reservedInputs.state !== 'reserved') {
        throw new Error('Bitcoin input reservation is not ready')
      }
      inputReservation = reservedInputs
      assertNotCancelled(input.signal)
      const commonBuildInput = {
        selection,
        masterFingerprint,
        lockTime: tipHeight,
        ...(previousTransactions === undefined ? {} : { previousTransactions })
      } as const
      if (ledgerAccount && BigInt(selection.changeSats) > 0n) {
        if (!this.options.changeReservations) {
          throw new Error('Ledger Bitcoin change reservation is unavailable')
        }
        changeReservation = await this.options.changeReservations.reserve({
          ...scope,
          addressType,
          transactionId,
          signal: input.signal
        })
        if (!changeReservation.address || changeReservation.state !== 'reserved') {
          throw new Error('Ledger Bitcoin change reservation is not ready')
        }
      }
      const prepared: PreparedBitcoinPsbt =
        BigInt(selection.changeSats) === 0n
          ? buildBitcoinPsbt(commonBuildInput)
          : buildBitcoinPsbt({
              ...commonBuildInput,
              change: {
                address: changeReservation?.address ?? derivedSigner,
                outputPosition: await this.changeOutputPosition(transactionId)
              }
            })
      return Object.freeze({
        transactionId,
        signerAddress: signer,
        feeRate,
        selection,
        inputReservation,
        changeReservation,
        prepared,
        discoveryUpdatedAt
      })
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...(changeReservation === null || !this.options.changeReservations
          ? []
          : [
              this.options.changeReservations.abandon(
                {
                  chainAccount: changeReservation.chainAccount,
                  accountIndex: changeReservation.accountIndex,
                  addressType: changeReservation.addressType
                },
                changeReservation.transactionId
              )
            ]),
        ...(inputReservation === null
          ? []
          : [
              this.options.inputReservations.release(
                {
                  chainAccount: inputReservation.chainAccount,
                  accountIndex: inputReservation.accountIndex,
                  addressType: inputReservation.addressType
                },
                inputReservation.transactionId
              )
            ])
      ])
      if (cleanup.some(result => result.status === 'rejected')) {
        throw new Error('Bitcoin transfer preparation cleanup failed')
      }
      throw error
    }
  }

  async preparePrivate(
    input: PrepareBitcoinPrivateTransferInput
  ): Promise<PreparedBitcoinTransferPlan> {
    if (
      !isRecord(input) ||
      !hasExactKeys(
        input,
        [
          'chainAccount',
          'accountIndex',
          'transactionId',
          'recipient',
          'amount',
          'publicKey',
          'publicReceiveAddress'
        ],
        ['privateExecutionAddress', 'feeTargetBlocks', 'feeRateSatsPerVbyte', 'signal']
      ) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      throw new Error('Invalid Bitcoin private transfer preparation input')
    }
    if (
      typeof input.privateExecutionAddress !== 'string' ||
      input.privateExecutionAddress.length === 0
    ) {
      throw new Error('Bitcoin private execution address is unavailable')
    }
    const scope = parseScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex
    })
    const transactionId = parseTransactionId(input.transactionId)
    const chainId = parseBitcoinChain(scope.chainAccount.scope.chainId)
    const privateExecutionAddress = parseBitcoinAddress(
      input.privateExecutionAddress,
      chainId,
      'p2wpkh'
    )
    const publicReceiveAddress = parseBitcoinAddress(input.publicReceiveAddress, chainId)
    if (privateExecutionAddress === publicReceiveAddress) {
      throw new Error('Bitcoin private execution address is unavailable')
    }
    const publicKey = parseBitcoinPublicKey(input.publicKey)
    const recipient = parseBitcoinAddress(input.recipient, chainId)
    if (recipient === publicReceiveAddress) {
      throw new Error('Bitcoin private transfer cannot pay the public address')
    }
    const amount = parseBitcoinTransferAmount(input.amount)
    if (input.feeTargetBlocks !== undefined && input.feeRateSatsPerVbyte !== undefined) {
      throw new Error('Bitcoin fee target and explicit fee rate are mutually exclusive')
    }
    const feeTargetBlocks = parseBitcoinIndex(
      input.feeTargetBlocks ?? BITCOIN_DEFAULT_FEE_TARGET_BLOCKS,
      'Bitcoin fee target',
      BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS
    )
    if (feeTargetBlocks === 0) throw new Error('Invalid Bitcoin fee target')
    const explicitFeeRate =
      input.feeRateSatsPerVbyte === undefined
        ? undefined
        : parseBitcoinFeeRate(input.feeRateSatsPerVbyte)
    assertNotCancelled(input.signal)

    await this.options.rpc.assertExpectedChain(input.signal)
    const [tipHeight, feeEstimates, listedUtxos] = await Promise.all([
      this.options.rpc.getTipHeight(input.signal),
      explicitFeeRate === undefined
        ? this.options.rpc.getFeeEstimates(input.signal)
        : Promise.resolve(null),
      this.options.rpc.getAddressUtxos(privateExecutionAddress, input.signal)
    ])
    assertNotCancelled(input.signal)
    const feeRate =
      explicitFeeRate === undefined
        ? selectBitcoinFeeRate(feeEstimates, feeTargetBlocks)
        : Object.freeze({
            requestedTargetBlocks: feeTargetBlocks,
            sourceTargetBlocks: feeTargetBlocks,
            satsPerVbyte: explicitFeeRate
          })
    const unavailableOutpoints = new Set(
      (await this.options.inputReservations.list({ ...scope, addressType: 'p2wpkh' }))
        .filter(reservation => reservation.transactionId !== transactionId)
        .flatMap(reservation =>
          reservation.outpoints.map(outpoint => `${outpoint.transactionId}:${outpoint.outputIndex}`)
        )
    )
    const spendable = await this.privateExecutionUtxos({
      chainId,
      accountIndex: scope.accountIndex,
      privateExecutionAddress,
      publicReceiveAddress,
      publicKey,
      listed: listedUtxos,
      tipHeight,
      unavailableOutpoints,
      signal: input.signal
    })
    const selection = selectBitcoinCoins({
      chainId,
      accountIndex: scope.accountIndex,
      addressType: 'p2wpkh',
      recipient,
      amount,
      feeRateSatsPerVbyte: feeRate.satsPerVbyte,
      utxos: spendable
    })
    if (
      selection.selectedUtxos.some(
        utxo => utxo.address === publicReceiveAddress || utxo.address !== privateExecutionAddress
      )
    ) {
      throw new Error('Bitcoin private transfer cannot spend the public address')
    }
    const previousTransactions = await Promise.all(
      [...new Set(selection.selectedUtxos.map(utxo => utxo.transactionId))].map(
        async previousTransactionId =>
          Object.freeze({
            transactionId: previousTransactionId,
            rawTransactionHex: await this.options.rpc.getRawTransaction(
              previousTransactionId,
              input.signal
            )
          })
      )
    )
    assertNotCancelled(input.signal)

    let inputReservation: BitcoinInputReservation | null = null
    try {
      const reservedInputs = parseBitcoinInputReservation(
        await this.options.inputReservations.reserve({
          ...scope,
          addressType: 'p2wpkh',
          transactionId,
          outpoints: inputOutpoints(selection),
          now: this.timestamp()
        }),
        { ...scope, addressType: 'p2wpkh' },
        transactionId
      )
      if (reservedInputs.state !== 'reserved') {
        throw new Error('Bitcoin input reservation is not ready')
      }
      inputReservation = reservedInputs
      assertNotCancelled(input.signal)
      const prepared = buildBitcoinPrivateExecutionPsbt({
        selection,
        publicKey,
        lockTime: tipHeight,
        previousTransactions,
        privateExecutionAddress,
        publicReceiveAddress,
        changeOutputPosition:
          BigInt(selection.changeSats) === 0n
            ? null
            : await this.changeOutputPosition(transactionId)
      })
      if (prepared.changeAddress !== null && prepared.changeAddress !== privateExecutionAddress) {
        throw new Error(
          'Bitcoin private transfer change must return to the private execution address'
        )
      }
      return Object.freeze({
        transactionId,
        signerAddress: privateExecutionAddress,
        feeRate,
        selection,
        inputReservation,
        changeReservation: null,
        prepared,
        discoveryUpdatedAt: this.timestamp()
      })
    } catch (error) {
      if (inputReservation !== null) {
        await this.options.inputReservations.release(
          {
            chainAccount: inputReservation.chainAccount,
            accountIndex: inputReservation.accountIndex,
            addressType: inputReservation.addressType
          },
          inputReservation.transactionId
        )
      }
      throw error
    }
  }

  private async privateExecutionUtxos(input: {
    readonly chainId: ReturnType<typeof parseBitcoinChain>
    readonly accountIndex: number
    readonly privateExecutionAddress: string
    readonly publicReceiveAddress: string
    readonly publicKey: string
    readonly listed: readonly BitcoinUtxo[]
    readonly tipHeight: number
    readonly unavailableOutpoints: ReadonlySet<string>
    readonly signal?: AbortSignal
  }) {
    if (!Array.isArray(input.listed) || input.listed.length > 1_000) {
      throw new Error('Invalid Bitcoin private execution UTXOs')
    }
    const network = input.chainId === BITCOIN_MAINNET_CHAIN_ID ? networks.bitcoin : networks.testnet
    const seen = new Set<string>()
    const spendable = []
    for (const utxo of input.listed) {
      const key = `${utxo.transactionId}:${utxo.outputIndex}`
      if (seen.has(key)) throw new Error('Duplicate Bitcoin private execution UTXO')
      seen.add(key)
      assertNotCancelled(input.signal)
      const rawTransactionHex = await this.options.rpc.getRawTransaction(
        utxo.transactionId,
        input.signal
      )
      const spent = spentOutputAddress(rawTransactionHex, utxo.outputIndex, network)
      if (spent === input.publicReceiveAddress) {
        throw new Error('Bitcoin private transfer cannot spend the public address')
      }
      if (spent !== input.privateExecutionAddress) {
        throw new Error('Bitcoin private transfer input is not the private execution address')
      }
      if (!utxo.status?.confirmed || input.unavailableOutpoints.has(key)) continue
      const blockHeight = utxo.status.blockHeight ?? 0
      if (blockHeight > input.tipHeight) {
        throw new Error('Bitcoin discovery contains a UTXO above the current tip')
      }
      // Coin selection accepts this imported origin. The PSBT signer uses the same "m" path.
      spendable.push(
        Object.freeze({
          chainId: input.chainId,
          addressType: 'p2wpkh' as const,
          accountIndex: input.accountIndex,
          change: false,
          addressIndex: 0,
          address: input.privateExecutionAddress,
          derivationPath: 'm',
          publicKey: input.publicKey,
          transactionId: utxo.transactionId,
          outputIndex: utxo.outputIndex,
          valueSats: utxo.valueRaw,
          blockHeight
        })
      )
    }
    return spendable
  }

  private async changeOutputPosition(
    transactionId: TransactionId
  ): Promise<BitcoinChangeOutputPosition> {
    const position = await (this.options.selectChangeOutputPosition ?? defaultChangeOutputPosition)(
      transactionId
    )
    if (position !== 'first' && position !== 'last') {
      throw new Error('Invalid Bitcoin change output position')
    }
    return position
  }

  private timestamp(): number {
    const value = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Bitcoin transfer preparation timestamp')
    }
    return value
  }
}
