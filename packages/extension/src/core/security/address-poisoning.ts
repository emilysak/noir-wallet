import type { ActivityItem } from '@/core/activity'
import { parseNearAccountId } from '@/core/chains/near'
import { BITCOIN_CHAIN_IDS, ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'

export const ADDRESS_POISONING_WARNING =
  'This address resembles a previous recipient, or it appeared in a zero-value token transfer this wallet did not sign. Check the highlighted middle before sending.'

export interface AddressPoisoningParty {
  readonly chainId: string
  readonly address: string
}

const TRUSTED_SOURCES = new Set<ActivityItem['source']>(['wallet-v2', 'zcash-v1'])
const TRUSTED_STATUSES = new Set<ActivityItem['status']>(['broadcast', 'confirming', 'final'])
const BITCOIN_CHAIN_ID_SET = new Set<string>(Object.values(BITCOIN_CHAIN_IDS))
const ZCASH_CHAIN_ID_SET = new Set<string>(Object.values(ZCASH_CHAIN_IDS))
const BECH32_PREFIXES = ['bc1p', 'bc1q', 'tb1p', 'tb1q'] as const

type ClassifiedAddress =
  | { readonly kind: 'evm' | 'near-implicit' | 'solana'; readonly body: string }
  | { readonly kind: 'bitcoin'; readonly prefix: string; readonly body: string }
  | { readonly kind: 'zcash-transparent'; readonly scheme: string; readonly body: string }
  | { readonly kind: 'near-named'; readonly label: string; readonly parent: string }

function classify(chainId: string, address: string): ClassifiedAddress | null {
  if (chainId === 'evm:all' || chainId.startsWith('eip155:')) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null
    return { kind: 'evm', body: address.slice(2).toLowerCase() }
  }
  if (chainId.startsWith('near:')) {
    let accountId: string
    try {
      accountId = parseNearAccountId(address)
    } catch {
      return null
    }
    if (/^[0-9a-f]{64}$/.test(accountId)) return { kind: 'near-implicit', body: accountId }
    const labels = accountId.split('.')
    return {
      kind: 'near-named',
      label: labels[0] ?? '',
      parent: labels.slice(1).join('.')
    }
  }
  if (chainId.startsWith('solana:')) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null
    return { kind: 'solana', body: address }
  }
  if (BITCOIN_CHAIN_ID_SET.has(chainId)) return classifyBitcoin(address)
  if (ZCASH_CHAIN_ID_SET.has(chainId)) return classifyZcashTransparent(address)
  return null
}

function classifyBitcoin(address: string): ClassifiedAddress | null {
  const lower = address.toLowerCase()
  const bech32 = BECH32_PREFIXES.find(prefix => lower.startsWith(prefix))
  if (bech32) {
    const body = lower.slice(bech32.length)
    return body.length >= 8 ? { kind: 'bitcoin', prefix: bech32, body } : null
  }
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{8,}$/.test(address)) {
    return { kind: 'bitcoin', prefix: address[0] ?? '', body: address.slice(1) }
  }
  return null
}

function classifyZcashTransparent(address: string): ClassifiedAddress | null {
  const match = /^(t1|t3|tm|t2)([a-km-zA-HJ-NP-Z1-9]{33})$/.exec(address)
  if (!match?.[1] || !match[2]) return null
  return { kind: 'zcash-transparent', scheme: match[1], body: match[2] }
}

function identity(parsed: ClassifiedAddress): string {
  switch (parsed.kind) {
    case 'evm':
    case 'near-implicit':
    case 'solana':
      return `${parsed.kind}:${parsed.body}`
    case 'bitcoin':
      return `bitcoin:${parsed.prefix}:${parsed.body}`
    case 'zcash-transparent':
      return `zcash:${parsed.scheme}:${parsed.body}`
    case 'near-named':
      return `near-named:${parsed.label}.${parsed.parent}`
  }
}

function sameParty(left: AddressPoisoningParty, right: AddressPoisoningParty): boolean {
  const parsedLeft = classify(left.chainId, left.address)
  const parsedRight = classify(right.chainId, right.address)
  return (
    parsedLeft !== null && parsedRight !== null && identity(parsedLeft) === identity(parsedRight)
  )
}

function edgesMatch(left: string, right: string): boolean {
  return (
    left !== right &&
    left.length === right.length &&
    left.length >= 8 &&
    left.startsWith(right.slice(0, 4)) &&
    left.endsWith(right.slice(-4))
  )
}

function foldNearLabel(label: string): string {
  return label.replace(/[-_]/g, '').replace(/[01i]/g, character => (character === '0' ? 'o' : 'l'))
}

function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 1) return 2
  const rows = left.length + 1
  const columns = right.length + 1
  const distances = Array.from({ length: rows }, () => Array<number>(columns).fill(0))
  for (let row = 0; row < rows; row += 1) distances[row]![0] = row
  for (let column = 0; column < columns; column += 1) distances[0]![column] = column
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      distances[row]![column] = Math.min(
        distances[row - 1]![column]! + 1,
        distances[row]![column - 1]! + 1,
        distances[row - 1]![column - 1]! + cost
      )
    }
  }
  return distances[left.length]![right.length]!
}

function namedAccountsLookSimilar(
  left: Extract<ClassifiedAddress, { kind: 'near-named' }>,
  right: Extract<ClassifiedAddress, { kind: 'near-named' }>
): boolean {
  if (!left.parent || left.parent !== right.parent || left.label === right.label) return false
  if (foldNearLabel(left.label) === foldNearLabel(right.label)) return true
  const shorter = Math.min(left.label.length, right.label.length)
  return shorter >= 4 && editDistance(left.label, right.label) === 1
}

export function addressesLookSimilar(
  left: AddressPoisoningParty,
  right: AddressPoisoningParty
): boolean {
  const parsedLeft = classify(left.chainId, left.address)
  const parsedRight = classify(right.chainId, right.address)
  if (!parsedLeft || !parsedRight || parsedLeft.kind !== parsedRight.kind) return false
  if (identity(parsedLeft) === identity(parsedRight)) return false
  switch (parsedLeft.kind) {
    case 'evm':
    case 'near-implicit':
    case 'solana':
      return parsedRight.kind === parsedLeft.kind && edgesMatch(parsedLeft.body, parsedRight.body)
    case 'bitcoin':
      return (
        parsedRight.kind === 'bitcoin' &&
        parsedLeft.prefix === parsedRight.prefix &&
        edgesMatch(parsedLeft.body, parsedRight.body)
      )
    case 'zcash-transparent':
      return (
        parsedRight.kind === 'zcash-transparent' &&
        parsedLeft.scheme === parsedRight.scheme &&
        edgesMatch(parsedLeft.body, parsedRight.body)
      )
    case 'near-named':
      return parsedRight.kind === 'near-named' && namedAccountsLookSimilar(parsedLeft, parsedRight)
  }
}

/** Wallet-signed outgoing that reached submission. Indexed event logs are not trusted. */
export function isTrustedOutgoingActivity(item: ActivityItem): boolean {
  const recipient = item.snapshot?.recipient
  const sender = item.snapshot?.sender
  if (
    !TRUSTED_SOURCES.has(item.source) ||
    !TRUSTED_STATUSES.has(item.status) ||
    item.failureCode ||
    item.snapshot?.direction !== 'outgoing' ||
    !recipient?.address ||
    !sender?.address ||
    sameParty(sender, recipient) ||
    item.segments?.some(segment => segment.evidence?.replacementTransactionHash)
  ) {
    return false
  }
  return classify(recipient.chainId, recipient.address) !== null
}

function matchesAny(
  candidate: AddressPoisoningParty,
  parties: readonly AddressPoisoningParty[]
): boolean {
  return parties.some(party => sameParty(candidate, party))
}

export function assessAddressPoisoning(input: {
  readonly candidate: AddressPoisoningParty
  readonly activity: readonly ActivityItem[]
  readonly plantedRecipients?: readonly AddressPoisoningParty[]
  readonly plantedSenders?: readonly AddressPoisoningParty[]
  readonly contacts?: readonly AddressPoisoningParty[]
}): boolean {
  const trusted = input.activity.flatMap(item => {
    if (!isTrustedOutgoingActivity(item) || !item.snapshot?.recipient) return []
    return [item.snapshot.recipient]
  })
  const contacts = input.contacts ?? []
  if (matchesAny(input.candidate, trusted) || matchesAny(input.candidate, contacts)) return false
  if (
    matchesAny(input.candidate, input.plantedRecipients ?? []) ||
    matchesAny(input.candidate, input.plantedSenders ?? [])
  ) {
    return true
  }
  return (
    trusted.some(party => addressesLookSimilar(input.candidate, party)) ||
    contacts.some(party => addressesLookSimilar(input.candidate, party))
  )
}
