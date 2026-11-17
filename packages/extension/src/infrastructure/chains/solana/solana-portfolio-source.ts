import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import type { PortfolioReadErrorCode, PortfolioSourceSnapshot } from '@/core/portfolio'
import { logger } from '@/lib/logger'

import { readSolanaBalances } from './solana-balance-reader'
import {
  parseSolanaPublicKey,
  SolanaRpcError,
  type SolanaReadRpc,
  type SolanaRpcErrorCode
} from './solana-rpc-client'

export interface ReadSolanaPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<
    SolanaReadRpc,
    'assertExpectedChain' | 'getBalanceSnapshot' | 'getTokenAccountsByMints'
  >
  readonly privateAddress?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
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
    const tokenMints = input.assets
      .list(chainId)
      .flatMap(entry =>
        entry.asset.kind === 'token' && entry.asset.namespace === 'token'
          ? [entry.asset.reference]
          : []
      )
    const privateAddress =
      input.privateAddress === undefined ? undefined : parseSolanaPublicKey(input.privateAddress)
    if (privateAddress !== undefined && privateAddress === address) {
      throw new Error('Solana PEA address matches the main account')
    }
    const readBalances = (accountAddress: string) =>
      readSolanaBalances({
        chainId,
        address: accountAddress,
        rpc: input.rpc,
        tokenMints,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.now === undefined ? {} : { now: input.now })
      })
    const mainBalances = await readBalances(address)
    const privateBalances = privateAddress === undefined ? null : await readBalances(privateAddress)
    const updatedAt = Math.max(mainBalances.updatedAt, privateBalances?.updatedAt ?? 0)
    const privateTokens = new Map(
      (privateBalances?.tokens ?? []).map(token => [token.assetId, token] as const)
    )
    const tokenBalances = new Map(mainBalances.tokens.map(token => [token.assetId, token] as const))
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
        ...input.assets.list(chainId).flatMap(asset => {
          if (
            asset.asset.chainId !== chainId ||
            asset.asset.kind !== 'token' ||
            asset.asset.namespace !== 'token'
          ) {
            return []
          }
          const token = tokenBalances.get(asset.asset.id)
          const privateToken = privateTokens.get(asset.asset.id)
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
