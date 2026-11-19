import type { ActivityItem } from '@/core/activity'
import { BITCOIN_CHAIN_IDS } from '@/core/chains/registry/chain-ids'

const BITCOIN_CHAIN_ID_SET = new Set<string>(Object.values(BITCOIN_CHAIN_IDS))

// Esplora history for the single PEA address is stored apart from the selected
// public script type. The partition name is not an address.
export const BITCOIN_PRIVATE_ACTIVITY_CACHE_PARTITION = 'private-execution-p2wpkh'

function isBitcoinActivityItem(item: ActivityItem): boolean {
  return item.segments.some(
    segment => segment.target.kind === 'onchain' && BITCOIN_CHAIN_ID_SET.has(segment.target.chainId)
  )
}

export function bitcoinActivityReferencesPrivateExecution(
  item: ActivityItem,
  privateAddress: string
): boolean {
  if (!isBitcoinActivityItem(item)) return false
  const parties = [item.snapshot?.sender, item.snapshot?.recipient]
  return parties.some(
    party => party?.address === privateAddress && BITCOIN_CHAIN_ID_SET.has(party.chainId)
  )
}

function withoutPrivateAccountMode(item: ActivityItem): ActivityItem {
  if (item.accountMode !== 'private') return item
  const { accountMode: _accountMode, ...rest } = item
  return Object.freeze(rest)
}

export function partitionBitcoinPrivateExecutionActivity(
  items: readonly ActivityItem[],
  privateAddress: string | undefined,
  privateHistoryIds: ReadonlySet<string> = new Set()
): {
  readonly sharedItems: readonly ActivityItem[]
  readonly privateItems: readonly ActivityItem[]
} {
  const sharedItems: ActivityItem[] = []
  const privateItems: ActivityItem[] = []
  for (const item of items) {
    const privateItem =
      privateAddress !== undefined &&
      isBitcoinActivityItem(item) &&
      (privateHistoryIds.has(item.id) ||
        bitcoinActivityReferencesPrivateExecution(item, privateAddress))
    if (!privateItem) {
      sharedItems.push(
        privateAddress !== undefined && isBitcoinActivityItem(item)
          ? withoutPrivateAccountMode(item)
          : item
      )
      continue
    }
    privateItems.push(
      item.accountMode === 'private'
        ? item
        : Object.freeze({ ...item, accountMode: 'private' as const })
    )
  }
  return Object.freeze({
    sharedItems: Object.freeze(sharedItems),
    privateItems: Object.freeze(privateItems)
  })
}
