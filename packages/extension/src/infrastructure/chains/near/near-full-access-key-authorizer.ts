import { parseChainId } from '@/core/chains/registry'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { StorageV2ReadRepository } from '@/ports/repositories'

import type { NearReadRpc } from './near-rpc-types'
import {
  assertVerifiedNearSnapshot,
  type NearFullAccessKeyDeletionGrant,
  NearFullAccessKeyDeletionRefused,
  selectRetainedNearFullAccessKey,
  usableNearPublicKeys
} from './near-full-access-key-removal'

export interface AuthorizeNearFullAccessKeyDeletionInput {
  readonly repository: Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>
  readonly rpc: Pick<NearReadRpc, 'listAccessKeys'>
  readonly keyDomainId: KeyDomainId
  readonly chainId: string
  readonly signerId: string
  readonly deletedPublicKeys: readonly string[]
  readonly signal?: AbortSignal
}

export async function authorizeNearFullAccessKeyDeletion(
  input: AuthorizeNearFullAccessKeyDeletionInput
): Promise<NearFullAccessKeyDeletionGrant | null> {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'near') {
    throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion chain is invalid')
  }
  const pointer = await input.repository.getActivePointer()
  if (!pointer) throw new Error('Active Storage V2 generation is missing')
  const snapshot = await input.repository.getSnapshot(pointer.generationId)
  if (!snapshot) throw new Error('Active Storage V2 generation is missing')
  assertVerifiedNearSnapshot(snapshot, pointer.generationId, pointer.sourceFingerprint)
  const listed = await input.rpc.listAccessKeys(input.signerId, input.signal)
  if (!listed || listed.accountId !== input.signerId) {
    throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion target was not found')
  }
  const decision = selectRetainedNearFullAccessKey({
    keys: listed.keys,
    deletedPublicKeys: input.deletedPublicKeys,
    walletPublicKeys: usableNearPublicKeys({
      chainAccounts: snapshot.chainAccounts,
      addresses: snapshot.addresses,
      keyDomainId: input.keyDomainId,
      chainId: chainId.id
    })
  })
  if (decision.kind === 'not-full-access') return null
  return Object.freeze({
    chainId: chainId.id,
    signerId: input.signerId,
    deletedPublicKeys: decision.deletedFullAccessPublicKeys,
    retainedPublicKey: decision.retainedPublicKey
  })
}
