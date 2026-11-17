import type { ChainAccount } from '@/core/accounts/domain'
import { createAssetId, parseChainId, type AssetRegistry } from '@/core/chains/registry'
import type { PortfolioReadErrorCode, PortfolioSourceSnapshot } from '@/core/portfolio'

import {
  readNearBalances,
  type NearBalanceReadModel,
  type NearFungibleTokenDefinition,
  type NearFungibleTokenReadModel
} from './near-balance-reader'
import { readNearAccountId } from './near-rpc-codecs'
import { NearRpcError, type NearReadRpc, type NearRpcErrorCode } from './near-rpc-types'
import type { NearAccountTokenInventoryClient } from './near-fastnear-client'

export interface ReadNearPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<
    NearReadRpc,
    'assertExpectedChain' | 'getAccount' | 'getFinalBlock' | 'getFungibleTokenBalance'
  >
  readonly tokenInventory?: NearAccountTokenInventoryClient
  readonly customTokens?: readonly NearFungibleTokenDefinition[]
  readonly privateAddress?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function mapErrorCode(code: NearRpcErrorCode): PortfolioReadErrorCode {
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
    case 'account-not-found':
    case 'access-key-not-found':
    case 'transaction-not-found':
    case 'rpc-error':
    case 'cancelled':
      return 'unknown'
  }
}

function parseAccountId(chainAccount: ChainAccount): string {
  if (chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('NEAR Portfolio requires an account-identifier binding')
  }
  if (
    chainAccount.derivation.scheme !== 'slip10' &&
    chainAccount.derivation.scheme !== 'imported'
  ) {
    throw new Error('NEAR Portfolio ChainAccount uses an unsupported derivation scheme')
  }
  return readNearAccountId(chainAccount.identity.value, 'NEAR Portfolio account ID')
}

function customTokenDefinition(
  contractId: string,
  symbol: string,
  decimals: number
): NearFungibleTokenDefinition {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Invalid NEAR fungible token metadata')
  }
  return Object.freeze({ contractId, symbol, decimals })
}

// FastNear omits contracts it has not indexed and the balance reader then
// reports zero. Saved custom NEP-141 tokens are always read with ft_balance_of.
async function mergeCustomNearTokenBalances(
  balances: NearBalanceReadModel,
  accountId: string,
  customTokens: readonly NearFungibleTokenDefinition[],
  rpc: ReadNearPortfolioSourceInput['rpc'],
  signal: AbortSignal | undefined
): Promise<NearBalanceReadModel> {
  if (customTokens.length === 0) return balances
  const chainId = parseChainId(balances.chainId).id
  const customRows = await Promise.all(
    customTokens.map(async (definition): Promise<NearFungibleTokenReadModel> => {
      const balance = await rpc.getFungibleTokenBalance(definition.contractId, accountId, signal)
      if (balance.contractId !== definition.contractId || balance.accountId !== accountId) {
        throw new Error('NEAR fungible token response identity mismatch')
      }
      return Object.freeze({
        assetId: createAssetId(chainId, 'nep141', definition.contractId.replace(/_/g, '%5F')),
        contractId: definition.contractId,
        symbol: definition.symbol,
        decimals: definition.decimals,
        amountRaw: balance.amountRaw,
        blockHash: balance.blockHash,
        blockHeight: balance.blockHeight
      })
    })
  )
  const customAssetIds = new Set(customRows.map(token => token.assetId))
  return Object.freeze({
    ...balances,
    tokens: Object.freeze(
      [...balances.tokens.filter(token => !customAssetIds.has(token.assetId)), ...customRows].sort(
        (left, right) => left.assetId.localeCompare(right.assetId)
      )
    )
  })
}

function splitBalance(mainRaw: string, privateRaw: string, updatedAt: number) {
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

export async function readNearPortfolioSource(
  input: ReadNearPortfolioSourceInput
): Promise<PortfolioSourceSnapshot> {
  const accountId = parseAccountId(input.chainAccount)
  const chainId = input.chainAccount.scope.chainId
  const nativeAssetId = `${chainId}/slip44:397`
  const nativeAsset = input.assets.resolve(nativeAssetId)
  if (
    nativeAsset.asset.chainId !== chainId ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.asset.namespace !== 'slip44' ||
    nativeAsset.asset.reference !== '397'
  ) {
    throw new Error('NEAR Portfolio native asset binding is invalid')
  }
  const fungibleTokens = input.assets.list(nativeAsset.asset.chainId).flatMap(entry =>
    entry.asset.kind === 'token' && entry.asset.namespace === 'nep141'
      ? [
          Object.freeze({
            contractId: entry.asset.reference.replace(/%5F/gi, '_'),
            symbol: entry.metadata.symbol,
            decimals: entry.metadata.decimals,
            source: entry.source
          })
        ]
      : []
  )
  try {
    const privateAccountId =
      input.privateAddress === undefined
        ? undefined
        : readNearAccountId(input.privateAddress, 'NEAR PEA account ID')
    if (privateAccountId !== undefined && !/^[0-9a-f]{64}$/.test(privateAccountId)) {
      throw new Error('NEAR PEA address is invalid')
    }
    if (privateAccountId !== undefined && privateAccountId === accountId) {
      throw new Error('NEAR PEA address matches the main account')
    }
    const customByContract = new Map<string, NearFungibleTokenDefinition>()
    for (const token of fungibleTokens) {
      if (token.source !== 'user-added') continue
      const contractId = readNearAccountId(token.contractId, 'NEAR fungible token contract ID')
      customByContract.set(
        contractId,
        customTokenDefinition(contractId, token.symbol, token.decimals)
      )
    }
    for (const token of input.customTokens ?? []) {
      const contractId = readNearAccountId(token.contractId, 'NEAR fungible token contract ID')
      customByContract.set(
        contractId,
        customTokenDefinition(contractId, token.symbol, token.decimals)
      )
    }
    const customTokens = Object.freeze([...customByContract.values()])
    const customContractIds = new Set(customTokens.map(token => token.contractId))
    const trustedTokens = fungibleTokens.flatMap(token => {
      const contractId = readNearAccountId(token.contractId, 'NEAR fungible token contract ID')
      if (customContractIds.has(contractId)) return []
      return [Object.freeze({ contractId, symbol: token.symbol, decimals: token.decimals })]
    })
    const readBalances = async (requestedAccountId: string) =>
      mergeCustomNearTokenBalances(
        await readNearBalances({
          chainId,
          accountId: requestedAccountId,
          rpc: input.rpc,
          allowMissingAccount: true,
          trustedTokens,
          ...(input.tokenInventory === undefined ? {} : { tokenInventory: input.tokenInventory }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.now === undefined ? {} : { now: input.now })
        }),
        requestedAccountId,
        customTokens,
        input.rpc,
        input.signal
      )
    const balances = await readBalances(accountId)
    if (privateAccountId === undefined) {
      return projectNearBalances(input.chainAccount, nativeAssetId, balances)
    }
    const privateBalances = await readBalances(privateAccountId)
    return projectSplitNearBalances(input.chainAccount, nativeAssetId, balances, privateBalances)
  } catch (error) {
    if (error instanceof NearRpcError && error.code === 'cancelled') throw error
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'error',
      balances: Object.freeze([]),
      errorCode: error instanceof NearRpcError ? mapErrorCode(error.code) : 'unknown'
    })
  }
}

function projectNearBalances(
  chainAccount: ChainAccount,
  nativeAssetId: string,
  balances: NearBalanceReadModel
): PortfolioSourceSnapshot {
  return Object.freeze({
    chainAccount,
    status: 'ready',
    balances: Object.freeze([
      Object.freeze({
        assetId: nativeAssetId,
        totalRaw: (
          BigInt(balances.native.amountRaw) + BigInt(balances.native.lockedRaw)
        ).toString(),
        spendableRaw: balances.native.amountRaw,
        availableRaw: balances.native.amountRaw,
        pendingRaw: '0',
        updatedAt: balances.updatedAt
      }),
      ...balances.tokens.map(token =>
        Object.freeze({
          assetId: token.assetId,
          totalRaw: token.amountRaw,
          spendableRaw: token.amountRaw,
          availableRaw: token.amountRaw,
          pendingRaw: '0',
          updatedAt: balances.updatedAt
        })
      )
    ])
  })
}

function projectSplitNearBalances(
  chainAccount: ChainAccount,
  nativeAssetId: string,
  mainBalances: NearBalanceReadModel,
  privateBalances: NearBalanceReadModel
): PortfolioSourceSnapshot {
  const updatedAt = Math.max(mainBalances.updatedAt, privateBalances.updatedAt)
  const privateTokens = new Map(
    privateBalances.tokens.map(token => [token.assetId, token] as const)
  )
  const mainTokens = new Map(mainBalances.tokens.map(token => [token.assetId, token] as const))
  const tokenIds = [...new Set([...mainTokens.keys(), ...privateTokens.keys()])].sort()
  return Object.freeze({
    chainAccount,
    status: 'ready',
    balances: Object.freeze([
      Object.freeze({
        assetId: nativeAssetId,
        ...splitBalance(mainBalances.native.amountRaw, privateBalances.native.amountRaw, updatedAt)
      }),
      ...tokenIds.flatMap(assetId => {
        const token = mainTokens.get(assetId)
        const privateToken = privateTokens.get(assetId)
        if (token && privateToken && token.decimals !== privateToken.decimals) return []
        return [
          Object.freeze({
            assetId,
            ...splitBalance(token?.amountRaw ?? '0', privateToken?.amountRaw ?? '0', updatedAt)
          })
        ]
      })
    ])
  })
}
