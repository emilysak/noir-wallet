import { nearPublicKeyFromImplicitAccountId, parseNearPublicKey } from '@/core/chains/near'
import { parseChainId } from '@/core/chains/registry'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { Address, ChainAccount } from '@/core/accounts/domain'
import type { StorageV2Snapshot } from '@/ports/repositories/storage-v2-types'

import type { NearAccessKeyPermission, NearReadRpc } from './near-rpc-types'

// A signed deletion can be broadcast after approval. An unknown transaction
// after this window is not evidence that the key was removed.
export const NEAR_FULL_ACCESS_KEY_REMOVAL_OBSERVATION_MS = 30 * 60 * 1000

export class NearFullAccessKeyDeletionRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NearFullAccessKeyDeletionRefused'
  }
}

export interface NearFullAccessKeyDeletionGrant {
  readonly chainId: string
  readonly signerId: string
  readonly deletedPublicKeys: readonly string[]
  readonly retainedPublicKey: string
}

export interface NearFullAccessKeyDeletionIntent extends NearFullAccessKeyDeletionGrant {
  readonly expiresAt: number
}

export interface NearFullAccessKeyRemovalRecord {
  readonly chainId: string
  readonly transactionId: string
  readonly signerId: string
  readonly deletedPublicKey: string
  readonly retainedPublicKey: string
  readonly recordedAt: number
}

export type NearFullAccessKeyRemovalObservation =
  | { readonly status: 'verified' }
  | { readonly status: 'pending' }
  | { readonly status: 'unconfirmed' }

interface ListedNearAccessKey {
  readonly publicKey: string
  readonly permission: NearAccessKeyPermission
}

export interface SelectRetainedNearFullAccessKeyInput {
  readonly keys: readonly ListedNearAccessKey[]
  readonly deletedPublicKeys: readonly string[]
  readonly walletPublicKeys: readonly string[]
}

export type RetainedNearFullAccessKey =
  | { readonly kind: 'not-full-access' }
  | {
      readonly kind: 'authorized'
      readonly retainedPublicKey: string
      readonly deletedFullAccessPublicKeys: readonly string[]
    }

function uniquePublicKeys(values: readonly string[], label: string): readonly string[] {
  const keys = values.map(value => parseNearPublicKey(value, label))
  if (new Set(keys).size !== keys.length) {
    throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion target is duplicated')
  }
  return Object.freeze([...keys].sort())
}

export function selectRetainedNearFullAccessKey(
  input: SelectRetainedNearFullAccessKeyInput
): RetainedNearFullAccessKey {
  const deletedPublicKeys = uniquePublicKeys(input.deletedPublicKeys, 'NEAR deleteKey public key')
  if (deletedPublicKeys.length === 0) {
    throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion target is missing')
  }
  const listed = new Map<string, ListedNearAccessKey>()
  for (const key of input.keys) {
    const publicKey = parseNearPublicKey(key.publicKey, 'NEAR access key public key')
    if (listed.has(publicKey)) {
      throw new NearFullAccessKeyDeletionRefused('NEAR access key list is ambiguous')
    }
    listed.set(publicKey, Object.freeze({ publicKey, permission: key.permission }))
  }
  const deletedFullAccessPublicKeys: string[] = []
  for (const publicKey of deletedPublicKeys) {
    const key = listed.get(publicKey)
    if (!key) {
      throw new NearFullAccessKeyDeletionRefused(
        'NEAR full-access key deletion target was not found'
      )
    }
    if (key.permission.kind === 'full-access') deletedFullAccessPublicKeys.push(publicKey)
  }
  if (deletedFullAccessPublicKeys.length === 0) {
    return Object.freeze({ kind: 'not-full-access' })
  }
  const deleted = new Set(deletedPublicKeys)
  const walletPublicKeys = new Set(
    uniquePublicKeys(input.walletPublicKeys, 'NEAR wallet public key')
  )
  const retainedPublicKey = [...listed.values()]
    .filter(
      key =>
        key.permission.kind === 'full-access' &&
        !deleted.has(key.publicKey) &&
        walletPublicKeys.has(key.publicKey)
    )
    .map(key => key.publicKey)
    .sort()[0]
  if (retainedPublicKey === undefined) {
    throw new NearFullAccessKeyDeletionRefused(
      'NEAR full-access key deletion requires another usable full-access key'
    )
  }
  return Object.freeze({
    kind: 'authorized',
    retainedPublicKey,
    deletedFullAccessPublicKeys: Object.freeze(deletedFullAccessPublicKeys)
  })
}

export function usableNearPublicKeys(input: {
  readonly chainAccounts: readonly ChainAccount[]
  readonly addresses: readonly Address[]
  readonly keyDomainId: KeyDomainId
  readonly chainId: string
}): readonly string[] {
  const chainId = parseChainId(input.chainId).id
  const chainAccountIds = new Set(
    input.chainAccounts
      .filter(
        chainAccount =>
          chainAccount.scope.keyDomainId === input.keyDomainId &&
          chainAccount.scope.chainId === chainId
      )
      .map(chainAccount => chainAccount.id)
  )
  const publicKeys = input.addresses.flatMap(address => {
    if (!chainAccountIds.has(address.chainAccountId) || address.scheme !== 'near') return []
    if (!/^[0-9a-f]{64}$/.test(address.value)) return []
    return [nearPublicKeyFromImplicitAccountId(address.value)]
  })
  return Object.freeze([...new Set(publicKeys)].sort())
}

export function canonicalNearRpcUrl(value: string): string {
  const url = new URL(value)
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('NEAR RPC URL must be a credential-free endpoint')
  }
  return url.toString()
}

export function selectNearCrossCheckRpcUrl(input: {
  readonly primaryRpcUrl: string
  readonly endpointUrls: readonly string[]
  readonly customEndpoint: boolean
}): string | null {
  if (input.customEndpoint) return null
  const primary = canonicalNearRpcUrl(input.primaryRpcUrl)
  for (const endpointUrl of input.endpointUrls) {
    let canonical: string
    try {
      canonical = canonicalNearRpcUrl(endpointUrl)
    } catch {
      continue
    }
    if (canonical !== primary) return canonical
  }
  return null
}

type NearFullAccessKeyRemovalReader = Pick<
  NearReadRpc,
  'getTransactionStatus' | 'getAccessKey' | 'assertExpectedChain'
>

async function removalMatches(
  rpc: Pick<NearReadRpc, 'getTransactionStatus' | 'getAccessKey'>,
  record: NearFullAccessKeyRemovalRecord,
  signal?: AbortSignal
): Promise<boolean> {
  const status = await rpc.getTransactionStatus(record.transactionId, record.signerId, signal)
  if (status.status !== 'final') return false
  const [deleted, retained] = await Promise.all([
    rpc.getAccessKey(record.signerId, record.deletedPublicKey, signal),
    rpc.getAccessKey(record.signerId, record.retainedPublicKey, signal)
  ])
  return deleted === null && retained?.permission.kind === 'full-access'
}

export async function observeNearFullAccessKeyRemoval(input: {
  readonly record: NearFullAccessKeyRemovalRecord
  readonly now: number
  readonly primary: Pick<NearReadRpc, 'getTransactionStatus' | 'getAccessKey'>
  readonly secondary?: Pick<NearReadRpc, 'getTransactionStatus' | 'getAccessKey'> | null
  readonly signal?: AbortSignal
}): Promise<NearFullAccessKeyRemovalObservation> {
  const record = input.record
  if (!Number.isSafeInteger(input.now) || input.now < record.recordedAt) {
    throw new Error('Invalid NEAR full-access key removal observation time')
  }
  const status = await input.primary.getTransactionStatus(
    record.transactionId,
    record.signerId,
    input.signal
  )
  if (status.status === 'unknown') {
    return input.now - record.recordedAt >= NEAR_FULL_ACCESS_KEY_REMOVAL_OBSERVATION_MS
      ? Object.freeze({ status: 'unconfirmed' })
      : Object.freeze({ status: 'pending' })
  }
  if (status.status === 'failed') return Object.freeze({ status: 'unconfirmed' })
  if (status.status !== 'final') return Object.freeze({ status: 'pending' })
  const removed = await removalMatches(input.primary, record, input.signal)
  if (!removed) return Object.freeze({ status: 'pending' })
  if (!input.secondary) return Object.freeze({ status: 'verified' })
  try {
    const agreed = await removalMatches(input.secondary, record, input.signal)
    return Object.freeze({ status: agreed ? 'verified' : 'pending' })
  } catch {
    return Object.freeze({ status: 'pending' })
  }
}

export interface NearFullAccessKeyRemovalPollResult {
  readonly verified: readonly NearFullAccessKeyRemovalRecord[]
  readonly unconfirmed: readonly NearFullAccessKeyRemovalRecord[]
  readonly pending: number
  readonly errors: number
}

export async function pollNearFullAccessKeyRemovals(input: {
  readonly records: readonly NearFullAccessKeyRemovalRecord[]
  readonly now: number
  readonly primary: Pick<NearReadRpc, 'getTransactionStatus' | 'getAccessKey'>
  readonly secondary?: NearFullAccessKeyRemovalReader | null
  readonly signal?: AbortSignal
}): Promise<NearFullAccessKeyRemovalPollResult> {
  if (input.records.length === 0) {
    return Object.freeze({
      verified: Object.freeze([]),
      unconfirmed: Object.freeze([]),
      pending: 0,
      errors: 0
    })
  }
  if (input.secondary) {
    try {
      await input.secondary.assertExpectedChain(input.signal)
    } catch {
      return Object.freeze({
        verified: Object.freeze([]),
        unconfirmed: Object.freeze([]),
        pending: input.records.length,
        errors: 0
      })
    }
  }
  const verified: NearFullAccessKeyRemovalRecord[] = []
  const unconfirmed: NearFullAccessKeyRemovalRecord[] = []
  let pending = 0
  let errors = 0
  for (const record of input.records) {
    try {
      const observation = await observeNearFullAccessKeyRemoval({
        record,
        now: input.now,
        primary: input.primary,
        secondary: input.secondary ?? null,
        signal: input.signal
      })
      if (observation.status === 'verified') verified.push(record)
      else if (observation.status === 'unconfirmed') unconfirmed.push(record)
      else pending += 1
    } catch {
      errors += 1
      pending += 1
    }
  }
  return Object.freeze({
    verified: Object.freeze(verified),
    unconfirmed: Object.freeze(unconfirmed),
    pending,
    errors
  })
}

export function assertVerifiedNearSnapshot(
  snapshot: StorageV2Snapshot,
  generationId: string,
  sourceFingerprint: string
): void {
  if (
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.generationId !== generationId ||
    snapshot.manifest.sourceFingerprint !== sourceFingerprint
  ) {
    throw new Error('Active Storage V2 generation does not match its pointer')
  }
}
