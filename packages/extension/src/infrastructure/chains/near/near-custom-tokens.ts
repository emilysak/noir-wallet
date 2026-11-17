import { getNearNetworkConfig } from '@/config/networks'
import { parseNearAccountId } from '@/core/chains/near'
import { createAssetId, parseChainId, type AssetDefinitionInput } from '@/core/chains/registry'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { Network } from '@/types'

import { parseNearFungibleTokenDisplay } from './near-ft-metadata'

const CATALOG_VERSION = 1
const MAXIMUM_TOKENS = 128
const MAXIMUM_TOKENS_PER_ACCOUNT = 32

export interface NearCustomTokenStorage {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
}

export interface NearCustomTokenRecord {
  readonly walletId: string
  readonly accountId: string
  readonly chainId: string
  readonly contractId: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly hidden: boolean
  readonly addedAt: number
}

export interface NearCustomTokenDraft {
  readonly walletId: string
  readonly accountId: string
  readonly chainId: string
  readonly contractId: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
}

interface NearCustomTokenSnapshot {
  readonly version: typeof CATALOG_VERSION
  readonly tokens: readonly NearCustomTokenRecord[]
}

export interface NearCustomTokenStore {
  readonly list: (scope: {
    readonly walletId: string
    readonly accountId: string
  }) => Promise<readonly NearCustomTokenRecord[]>
  readonly upsert: (draft: NearCustomTokenDraft) => Promise<NearCustomTokenRecord>
  readonly setHidden: (
    scope: { readonly walletId: string; readonly accountId: string; readonly contractId: string },
    hidden: boolean
  ) => Promise<NearCustomTokenRecord>
  readonly remove: (scope: {
    readonly walletId: string
    readonly accountId: string
    readonly contractId: string
  }) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function readScopeId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function tokenKey(
  token: Pick<NearCustomTokenRecord, 'walletId' | 'accountId' | 'contractId'>
): string {
  return `${token.walletId}\n${token.accountId}\n${token.contractId}`
}

export function nearCustomTokenAssetId(chainId: string, contractId: string): string {
  const parsedChainId = parseChainId(chainId)
  if (parsedChainId.namespace !== 'near') throw new Error('Invalid NEAR chain ID')
  const accountId = parseNearAccountId(contractId, 'NEAR token contract account')
  return createAssetId(parsedChainId.id, 'nep141', accountId.replace(/_/g, '%5F'))
}

export function nearCustomTokenDefinition(token: NearCustomTokenRecord): AssetDefinitionInput {
  return Object.freeze({
    chainId: token.chainId,
    namespace: 'nep141',
    reference: token.contractId,
    kind: 'token',
    metadata: Object.freeze({
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals
    }),
    source: 'user-added',
    verification: 'user-approved'
  })
}

function parseToken(value: unknown, chainId: string): NearCustomTokenRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'walletId',
      'accountId',
      'chainId',
      'contractId',
      'name',
      'symbol',
      'decimals',
      'hidden',
      'addedAt'
    ]) ||
    value.chainId !== chainId ||
    typeof value.hidden !== 'boolean' ||
    !Number.isSafeInteger(value.addedAt) ||
    (value.addedAt as number) < 0
  ) {
    throw new Error('Invalid custom NEAR token catalog.')
  }
  const display = parseNearFungibleTokenDisplay(value.name, value.symbol, value.decimals)
  return Object.freeze({
    walletId: readScopeId(value.walletId, 'wallet id'),
    accountId: readScopeId(value.accountId, 'account id'),
    chainId,
    contractId: parseNearAccountId(value.contractId, 'NEAR token contract account'),
    name: display.name,
    symbol: display.symbol,
    decimals: display.decimals,
    hidden: value.hidden,
    addedAt: value.addedAt as number
  })
}

function parseSnapshot(value: unknown, chainId: string): NearCustomTokenSnapshot {
  if (value === undefined) {
    return Object.freeze({ version: CATALOG_VERSION, tokens: Object.freeze([]) })
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'tokens']) ||
    value.version !== CATALOG_VERSION ||
    !Array.isArray(value.tokens) ||
    value.tokens.length > MAXIMUM_TOKENS
  ) {
    throw new Error('Invalid custom NEAR token catalog.')
  }
  const tokens = value.tokens.map(token => parseToken(token, chainId))
  if (new Set(tokens.map(tokenKey)).size !== tokens.length) {
    throw new Error('Invalid custom NEAR token catalog.')
  }
  return Object.freeze({ version: CATALOG_VERSION, tokens: Object.freeze(tokens) })
}

function serialize(snapshot: NearCustomTokenSnapshot): {
  version: typeof CATALOG_VERSION
  tokens: NearCustomTokenRecord[]
} {
  return {
    version: CATALOG_VERSION,
    tokens: snapshot.tokens.map(token => ({
      walletId: token.walletId,
      accountId: token.accountId,
      chainId: token.chainId,
      contractId: token.contractId,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      hidden: token.hidden,
      addedAt: token.addedAt
    }))
  }
}

export function createNearCustomTokenStore(
  storage: NearCustomTokenStorage,
  network: Network
): NearCustomTokenStore {
  const chainId = getNearNetworkConfig(network).chainId
  const storageKey = `near_custom_nep141_${network}_v1`
  let queue: Promise<void> = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const read = async (): Promise<NearCustomTokenSnapshot> =>
    parseSnapshot(await storage.get(storageKey), chainId)

  const write = (snapshot: NearCustomTokenSnapshot): Promise<void> =>
    storage.set(storageKey, serialize(snapshot))

  return Object.freeze({
    list: (scope: { readonly walletId: string; readonly accountId: string }) =>
      enqueue(async () => {
        const walletId = readScopeId(scope.walletId, 'wallet id')
        const accountId = readScopeId(scope.accountId, 'account id')
        return Object.freeze(
          (await read()).tokens
            .filter(token => token.walletId === walletId && token.accountId === accountId)
            .sort(
              (left, right) =>
                left.symbol.localeCompare(right.symbol) ||
                left.contractId.localeCompare(right.contractId)
            )
        )
      }),
    upsert: (draft: NearCustomTokenDraft) =>
      enqueue(async () => {
        const walletId = readScopeId(draft.walletId, 'wallet id')
        const accountId = readScopeId(draft.accountId, 'account id')
        if (draft.chainId !== chainId) {
          throw new Error('Token verification is only available for the active NEAR network.')
        }
        const contractId = parseNearAccountId(draft.contractId, 'NEAR token contract account')
        const display = parseNearFungibleTokenDisplay(draft.name, draft.symbol, draft.decimals)
        const snapshot = await read()
        const key = tokenKey({ walletId, accountId, contractId })
        const existing = snapshot.tokens.find(token => tokenKey(token) === key)
        const accountCount = snapshot.tokens.filter(
          token => token.walletId === walletId && token.accountId === accountId
        ).length
        if (!existing && accountCount >= MAXIMUM_TOKENS_PER_ACCOUNT) {
          throw new Error('The custom NEAR token list is full.')
        }
        const record = Object.freeze({
          walletId,
          accountId,
          chainId,
          contractId,
          name: display.name,
          symbol: display.symbol,
          decimals: display.decimals,
          hidden: false,
          addedAt: existing?.addedAt ?? Date.now()
        })
        if (!Number.isSafeInteger(record.addedAt) || record.addedAt < 0) {
          throw new Error('Invalid custom NEAR token catalog.')
        }
        const tokens = existing
          ? snapshot.tokens.map(token => (tokenKey(token) === key ? record : token))
          : [...snapshot.tokens, record]
        await write(Object.freeze({ version: CATALOG_VERSION, tokens: Object.freeze(tokens) }))
        return record
      }),
    setHidden: (
      scope: { readonly walletId: string; readonly accountId: string; readonly contractId: string },
      hidden: boolean
    ) =>
      enqueue(async () => {
        if (typeof hidden !== 'boolean') throw new Error('Invalid custom NEAR token visibility.')
        const walletId = readScopeId(scope.walletId, 'wallet id')
        const accountId = readScopeId(scope.accountId, 'account id')
        const contractId = parseNearAccountId(scope.contractId, 'NEAR token contract account')
        const snapshot = await read()
        const key = tokenKey({ walletId, accountId, contractId })
        const existing = snapshot.tokens.find(token => tokenKey(token) === key)
        if (!existing) throw new Error('This Token is not in the custom NEAR token list.')
        const record = Object.freeze({ ...existing, hidden })
        await write(
          Object.freeze({
            version: CATALOG_VERSION,
            tokens: Object.freeze(
              snapshot.tokens.map(token => (tokenKey(token) === key ? record : token))
            )
          })
        )
        return record
      }),
    remove: (scope: {
      readonly walletId: string
      readonly accountId: string
      readonly contractId: string
    }) =>
      enqueue(async () => {
        const walletId = readScopeId(scope.walletId, 'wallet id')
        const accountId = readScopeId(scope.accountId, 'account id')
        const contractId = parseNearAccountId(scope.contractId, 'NEAR token contract account')
        const snapshot = await read()
        const key = tokenKey({ walletId, accountId, contractId })
        if (!snapshot.tokens.some(token => tokenKey(token) === key)) {
          throw new Error('This Token is not in the custom NEAR token list.')
        }
        await write(
          Object.freeze({
            version: CATALOG_VERSION,
            tokens: Object.freeze(snapshot.tokens.filter(token => tokenKey(token) !== key))
          })
        )
      })
  })
}

export function createChromeNearCustomTokenStorage(): NearCustomTokenStorage {
  return Object.freeze({
    get: async (key: string): Promise<unknown> => {
      const stored: Record<string, unknown> = await chrome.storage.local.get(key)
      return stored[key]
    },
    set: async (key: string, value: unknown): Promise<void> => {
      await chrome.storage.local.set({ [key]: value })
    }
  })
}

export const nearCustomTokenStore = createNearCustomTokenStore(
  createChromeNearCustomTokenStorage(),
  DEFAULT_NETWORK
)
