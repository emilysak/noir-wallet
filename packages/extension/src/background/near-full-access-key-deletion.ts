import { authorizeNearFullAccessKeyDeletion } from '@/infrastructure/chains/near/near-full-access-key-authorizer'
import { ChromeSessionNearFullAccessKeyRemovalStore } from '@/infrastructure/chains/near/near-full-access-key-removal-store'
import type { NearReadRpc } from '@/infrastructure/chains/near/near-rpc-types'
import type { NearMultichainSigningClientOptions } from '@/infrastructure/keyring/multichain/near-signing-client'
import type { StorageV2ReadRepository } from '@/ports/repositories'

import { NEAR_TRANSACTION_MONITOR_ALARM } from './near-transaction-monitor'

type NearDeletionRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export function nearFullAccessKeyDeletionClientOptions(
  repository: NearDeletionRepository,
  rpc: Pick<NearReadRpc, 'listAccessKeys'>
): Pick<
  NearMultichainSigningClientOptions,
  'authorizeFullAccessKeyDeletion' | 'fullAccessKeyRemovals' | 'onFullAccessKeyRemovalRecorded'
> {
  return {
    fullAccessKeyRemovals: new ChromeSessionNearFullAccessKeyRemovalStore(),
    authorizeFullAccessKeyDeletion: input =>
      authorizeNearFullAccessKeyDeletion({
        repository,
        rpc,
        keyDomainId: input.keyDomainId,
        chainId: input.chainId,
        signerId: input.signerId,
        deletedPublicKeys: input.deletedPublicKeys,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }),
    onFullAccessKeyRemovalRecorded: () =>
      chrome.alarms.create(NEAR_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
  }
}
