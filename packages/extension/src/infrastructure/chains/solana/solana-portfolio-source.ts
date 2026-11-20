import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import type { PortfolioReadErrorCode, PortfolioSourceSnapshot } from '@/core/portfolio'
import { logger } from '@/lib/logger'

import type { AssetRegistryEntry } from '@/core/chains/registry'

import { readSolanaBalances } from './solana-balance-reader'
import {
  parseSolanaPublicKey,
  SolanaRpcError,
  type SolanaReadRpc,
  type SolanaRpcErrorCode,
  type SolanaTokenAccountBalance
} from './solana-rpc-client'

const MAXIMUM_RAW_AMOUNT_DIGITS = 128

export interface ReadSolanaPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<
    SolanaReadRpc,
    | 'assertExpectedChain'
    | 'getBalanceSnapshot'
    | 'getTokenAccountsByMints'
    | 'getTokenAccountsByOwner'
  >
  readonly trackedAssetIds?: ReadonlySet<string>
  readonly privateAddress?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

interface DiscoveredTokenBalance {
  readonly amountRaw: string
  readonly decimals: number
}

function mapErrorCode(code: SolanaRpcErrorCode): PortfolioReadErrorCode {
  switch (code) {
    case 'rate-limited':
      return 'rate-limited'
    case 'unauthorized':
      return 'unauthorized'
    case 'invalid-response':
    case 'chain-mismatch':
      return 'invalid-response'
    case 'network-unavailable':
    case 'timeout':
      return 'network-unavailable'
    case 'rpc-error':
    case 'cancelled':
      return 'unknown'
  }
}

function discoverRegistryTokens(
  accounts: readonly SolanaTokenAccountBalance[],
  registryByMint: ReadonlyMap<string, AssetRegistryEntry>,
  rejected: Set<string>
): Map<string, DiscoveredTokenBalance> {
  const amounts = new Map<string, { amount: bigint; decimals: number }>()
  for (const account of accounts) {
    const entry = registryByMint.get(account.mint)
    if (!entry) continue
    if (entry.metadata.decimals !== account.decimals) {
      rejected.add(entry.asset.id)
      continue
    }
    const current = amounts.get(entry.asset.id)
    const amount = BigInt(account.amountRaw)
    if (current) {
      current.amount += amount
      if (current.amount.toString().length > MAXIMUM_RAW_AMOUNT_DIGITS) {
        throw new Error('Solana token balance exceeds the supported range')
      }
      continue
    }
    amounts.set(entry.asset.id, { amount, decimals: account.decimals })
  }
  return new Map(
    [...amounts].map(([assetId, balance]) => [
      assetId,
      Object.freeze({ amountRaw: balance.amount.toString(), decimals: balance.decimals })
    ])
  )
}

function parseAccountAddress(chainAccount: ChainAccount): string {
  if (chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('Solana Portfolio requires an account-identifier binding')
  }
  if (
    chainAccount.derivation.scheme !== 'slip10' &&
    chainAccount.derivation.scheme !== 'imported'
  ) {
    throw new Error('Solana Portfolio ChainAccount uses an unsupported derivation scheme')
  }
  return parseSolanaPublicKey(chainAccount.identity.value)
}

export async function readSolanaPortfolioSource(
  input: ReadSolanaPortfolioSourceInput
): Promise<PortfolioSourceSnapshot> {
  const address = parseAccountAddress(input.chainAccount)
  const chainId = input.chainAccount.scope.chainId
  const nativeAssetId = `${chainId}/slip44:501`
  const nativeAsset = input.assets.resolve(nativeAssetId)
  if (
    nativeAsset.asset.chainId !== chainId ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.asset.namespace !== 'slip44' ||
    nativeAsset.asset.reference !== '501'
  ) {
    throw new Error('Solana Portfolio native asset binding is invalid')
  }
  try {
    const tokenEntries = input.assets
      .list(chainId)
      .filter(entry => entry.asset.kind === 'token' && entry.asset.namespace === 'token')
    const registryByMint = new Map(tokenEntries.map(entry => [entry.asset.reference, entry]))
    const privateAddress =
      input.privateAddress === undefined ? undefined : parseSolanaPublicKey(input.privateAddress)
    if (privateAddress !== undefined && privateAddress === address) {
      throw new Error('Solana PEA address matches the main account')
    }
    const readNative = (accountAddress: string) =>
      readSolanaBalances({
        chainId,
        address: accountAddress,
        rpc: input.rpc,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.now === undefined ? {} : { now: input.now })
      })
    // The asset registry may hold the full swap catalog. Discover held mints
    // from the owner instead of querying every mint.
    const discover = async (accountAddress: string, rejected: Set<string>) => {
      if (registryByMint.size === 0) return new Map<string, DiscoveredTokenBalance>()
      const [legacy, token2022] = await Promise.all([
        input.rpc.getTokenAccountsByOwner(accountAddress, 'legacy', input.signal),
        input.rpc.getTokenAccountsByOwner(accountAddress, 'token2022', input.signal)
      ])
      return discoverRegistryTokens(
        [...legacy.accounts, ...token2022.accounts],
        registryByMint,
        rejected
      )
    }
    const mainRejected = new Set<string>()
    const privateRejected = new Set<string>()
    const [mainBalances, privateBalances, mainTokens, privateTokenMap] = await Promise.all([
      readNative(address),
      privateAddress === undefined ? Promise.resolve(null) : readNative(privateAddress),
      discover(address, mainRejected),
      privateAddress === undefined
        ? Promise.resolve(null)
        : discover(privateAddress, privateRejected)
    ])
    const updatedAt = Math.max(mainBalances.updatedAt, privateBalances?.updatedAt ?? 0)
    const trackedAssetIds = input.trackedAssetIds ?? new Set<string>()
    const balanceFor = (mainRaw: string, privateRaw: string | undefined) => {
      if (privateRaw === undefined) {
        return Object.freeze({
          totalRaw: mainRaw,
          spendableRaw: mainRaw,
          availableRaw: mainRaw,
          pendingRaw: '0',
          updatedAt
        })
      }
      const totalRaw = (BigInt(mainRaw) + BigInt(privateRaw)).toString()
      return Object.freeze({
        totalRaw,
        mainRaw,
        privateRaw,
        spendableRaw: totalRaw,
        availableRaw: totalRaw,
        pendingRaw: '0',
        updatedAt
      })
    }
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'ready',
      balances: Object.freeze([
        Object.freeze({
          assetId: nativeAssetId,
          ...balanceFor(mainBalances.native.amountRaw, privateBalances?.native.amountRaw)
        }),
        ...tokenEntries.flatMap(asset => {
          const token = mainTokens.get(asset.asset.id)
          const privateToken = privateTokenMap?.get(asset.asset.id)
          const rejected = mainRejected.has(asset.asset.id) || privateRejected.has(asset.asset.id)
          const tracked = asset.source === 'user-added' || trackedAssetIds.has(asset.asset.id)
          if (!token && !privateToken && (!tracked || rejected)) return []
          if (
            (token && asset.metadata.decimals !== token.decimals) ||
            (privateToken && asset.metadata.decimals !== privateToken.decimals)
          ) {
            return []
          }
          return [
            Object.freeze({
              assetId: asset.asset.id,
              ...balanceFor(
                token?.amountRaw ?? '0',
                privateBalances === null ? undefined : (privateToken?.amountRaw ?? '0')
              )
            })
          ]
        })
      ])
    })
  } catch (error) {
    if (error instanceof SolanaRpcError && error.code === 'cancelled') throw error
    const errorCode = error instanceof SolanaRpcError ? mapErrorCode(error.code) : 'unknown'
    const cause =
      error instanceof SolanaRpcError ? error.code : error instanceof Error ? error.name : 'unknown'
    logger.warn(
      `Solana Portfolio refresh failed code=${errorCode} cause=${cause}`,
      input.chainAccount.scope.keyDomainId,
      input.chainAccount.scope.accountId
    )
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'error',
      balances: Object.freeze([]),
      errorCode
    })
  }
}
