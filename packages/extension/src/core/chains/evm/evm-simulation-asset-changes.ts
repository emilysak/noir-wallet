const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const UINT256_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const DISPLAY_CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/
const MAXIMUM_TRANSFERS = 128
const MAXIMUM_SYMBOL_CODE_POINTS = 32
const MAXIMUM_DECIMALS = 255
const UINT256_LIMIT = 1n << 256n
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

export interface EvmSimulationTokenTransfer {
  readonly contractAddress: string
  readonly from: string
  readonly to: string
  readonly amountRaw: string
}

export interface EvmSimulationTraceTransfer {
  readonly from: string
  readonly to: string
  readonly valueWei: string
}

export interface EvmSimulationTransfers {
  readonly tokenTransfers?: readonly EvmSimulationTokenTransfer[]
  readonly traceTransfers?: readonly EvmSimulationTraceTransfer[]
}

export interface EvmSimulationTokenMetadata {
  readonly contractAddress: string
  readonly symbol: string
  readonly decimals: number
  readonly verification: 'trusted' | 'user-approved'
}

export interface EvmSimulationAssetChangeInput {
  readonly account: string
  readonly tokenTransfers?: readonly unknown[]
  readonly traceTransfers?: readonly unknown[]
  readonly tokens?: readonly unknown[]
}

interface TrustedToken {
  readonly symbol: string
  readonly decimals: number
  readonly verification: 'trusted' | 'user-approved'
}

interface TokenMetadataIndex {
  readonly priced: ReadonlyMap<string, TrustedToken>
  readonly rejected: ReadonlySet<string>
  readonly reportedNames: ReadonlyMap<string, string>
}

export type EvmSimulationAssetChange =
  | {
      readonly kind: 'native'
      readonly direction: 'incoming' | 'outgoing'
      readonly amountRaw: string
    }
  | {
      readonly kind: 'token'
      readonly contractAddress: string
      readonly direction: 'incoming' | 'outgoing'
      readonly amountRaw: string
      readonly verification: 'trusted' | 'user-approved'
      readonly symbol: string
      readonly decimals: number
    }
  | {
      readonly kind: 'token'
      readonly contractAddress: string
      readonly direction: 'incoming' | 'outgoing'
      readonly amountRaw: string
      readonly verification: 'unverified'
      readonly reportedName?: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => actual.includes(key))
}

function readAddress(value: unknown, allowZero: boolean): string | undefined {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) return undefined
  const address = value.toLowerCase()
  if (!allowZero && address === ZERO_ADDRESS) return undefined
  return address
}

function readUint256(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !UINT256_PATTERN.test(value)) return undefined
  const amount = BigInt(value)
  return amount < UINT256_LIMIT ? amount : undefined
}

function readSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const symbol = value.normalize('NFC')
  if (
    symbol.length === 0 ||
    symbol.trim() !== symbol ||
    [...symbol].length > MAXIMUM_SYMBOL_CODE_POINTS ||
    DISPLAY_CONTROL_CHARACTERS.test(symbol)
  ) {
    return undefined
  }
  return symbol
}

function readTransferArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || value.length > MAXIMUM_TRANSFERS) return undefined
  return value
}

function applyDelta(net: Map<string, bigint>, rejected: Set<string>, key: string, delta: bigint) {
  if (rejected.has(key) || delta === 0n) return
  const next = (net.get(key) ?? 0n) + delta
  const magnitude = next < 0n ? -next : next
  if (magnitude >= UINT256_LIMIT) {
    rejected.add(key)
    net.delete(key)
    return
  }
  net.set(key, next)
}

function accountDelta(from: string, to: string, account: string, amount: bigint): bigint {
  if (from === to) return 0n
  let delta = 0n
  if (from === account) delta -= amount
  if (to === account) delta += amount
  return delta
}

function changeFromNet(amount: bigint): {
  readonly direction: 'incoming' | 'outgoing'
  readonly amountRaw: string
} | null {
  if (amount === 0n) return null
  return Object.freeze({
    direction: amount > 0n ? 'incoming' : 'outgoing',
    amountRaw: (amount > 0n ? amount : -amount).toString()
  })
}

function readDecimals(value: unknown): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_DECIMALS
  ) {
    return undefined
  }
  return value
}

function tokenMetadataIndex(tokens: readonly unknown[] | undefined): TokenMetadataIndex {
  const priced = new Map<string, TrustedToken>()
  const rejected = new Set<string>()
  const reportedNames = new Map<string, string>()
  const rejectedNames = new Set<string>()
  if (tokens === undefined || tokens.length > MAXIMUM_TRANSFERS) {
    return { priced, rejected, reportedNames }
  }
  for (const value of tokens) {
    if (!isRecord(value)) continue
    const contractAddress = readAddress(value.contractAddress, false)
    const symbol = readSymbol(value.symbol)
    if (!contractAddress || !symbol) continue
    const decimals = readDecimals(value.decimals)
    const verification = value.verification
    if (
      hasExactKeys(value, ['contractAddress', 'symbol', 'decimals', 'verification']) &&
      (verification === 'trusted' || verification === 'user-approved') &&
      decimals !== undefined
    ) {
      if (rejected.has(contractAddress)) continue
      const next = Object.freeze({
        symbol,
        decimals,
        verification
      })
      const current = priced.get(contractAddress)
      if (
        current &&
        (current.symbol !== next.symbol ||
          current.decimals !== next.decimals ||
          current.verification !== next.verification)
      ) {
        priced.delete(contractAddress)
        rejected.add(contractAddress)
        continue
      }
      priced.set(contractAddress, next)
      continue
    }
    // A trusted record that fails validation does not become a display name.
    if (value.verification === 'trusted' || rejectedNames.has(contractAddress)) continue
    const current = reportedNames.get(contractAddress)
    if (current && current !== symbol) {
      reportedNames.delete(contractAddress)
      rejectedNames.add(contractAddress)
      continue
    }
    reportedNames.set(contractAddress, symbol)
  }
  return { priced, rejected, reportedNames }
}

function tokenChanges(
  transfers: readonly unknown[] | undefined,
  account: string,
  tokens: TokenMetadataIndex
): readonly EvmSimulationAssetChange[] {
  if (transfers === undefined) return []
  const net = new Map<string, bigint>()
  const rejected = new Set<string>()
  for (const value of transfers) {
    if (!isRecord(value) || !hasExactKeys(value, ['contractAddress', 'from', 'to', 'amountRaw'])) {
      continue
    }
    const contractAddress = readAddress(value.contractAddress, false)
    const from = readAddress(value.from, true)
    const to = readAddress(value.to, true)
    const amount = readUint256(value.amountRaw)
    if (!contractAddress || !from || !to || amount === undefined) continue
    applyDelta(net, rejected, contractAddress, accountDelta(from, to, account, amount))
  }
  return [...net.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([contractAddress, amount]) => {
      const change = changeFromNet(amount)
      if (!change) return []
      const trusted = tokens.rejected.has(contractAddress)
        ? undefined
        : tokens.priced.get(contractAddress)
      const reportedName =
        trusted || tokens.rejected.has(contractAddress)
          ? undefined
          : tokens.reportedNames.get(contractAddress)
      return [
        Object.freeze(
          trusted
            ? {
                kind: 'token' as const,
                contractAddress,
                ...change,
                verification: trusted.verification,
                symbol: trusted.symbol,
                decimals: trusted.decimals
              }
            : {
                kind: 'token' as const,
                contractAddress,
                ...change,
                verification: 'unverified' as const,
                ...(reportedName === undefined ? {} : { reportedName })
              }
        )
      ]
    })
}

function nativeChange(
  transfers: readonly unknown[] | undefined,
  account: string
): EvmSimulationAssetChange | undefined {
  // Missing traces are unknown. Transaction value is not a native balance change.
  if (transfers === undefined) return undefined
  const net = new Map<string, bigint>()
  const rejected = new Set<string>()
  for (const value of transfers) {
    if (!isRecord(value) || !hasExactKeys(value, ['from', 'to', 'valueWei'])) continue
    const from = readAddress(value.from, true)
    const to = readAddress(value.to, true)
    const amount = readUint256(value.valueWei)
    if (!from || !to || amount === undefined) continue
    applyDelta(net, rejected, 'native', accountDelta(from, to, account, amount))
  }
  if (rejected.has('native')) return undefined
  const change = changeFromNet(net.get('native') ?? 0n)
  return change === null ? undefined : Object.freeze({ kind: 'native' as const, ...change })
}

export function readEvmSimulationTransfers(value: unknown): EvmSimulationTransfers | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).some(key => !isTransferKey(key))) return undefined
  const tokenTransfers = readOptionalTransfers(value, 'tokenTransfers')
  const traceTransfers = readOptionalTransfers(value, 'traceTransfers')
  if (tokenTransfers === null || traceTransfers === null) return undefined
  return Object.freeze({
    ...(tokenTransfers === undefined ? {} : { tokenTransfers }),
    ...(traceTransfers === undefined ? {} : { traceTransfers })
  }) as EvmSimulationTransfers
}

function isTransferKey(key: string): boolean {
  return key === 'tokenTransfers' || key === 'traceTransfers'
}

function readOptionalTransfers(
  value: Record<string, unknown>,
  key: 'tokenTransfers' | 'traceTransfers'
): readonly unknown[] | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined
  return readTransferArray(value[key]) ?? null
}

export function aggregateEvmSimulationAssetChanges(
  input: EvmSimulationAssetChangeInput
): readonly EvmSimulationAssetChange[] {
  const account = readAddress(input.account, false)
  if (!account) return Object.freeze([])
  const tokens = tokenMetadataIndex(
    input.tokens === undefined || input.tokens.length > MAXIMUM_TRANSFERS ? undefined : input.tokens
  )
  const tokenRows = tokenChanges(
    input.tokenTransfers === undefined || input.tokenTransfers.length > MAXIMUM_TRANSFERS
      ? undefined
      : input.tokenTransfers,
    account,
    tokens
  )
  const native = nativeChange(
    input.traceTransfers === undefined || input.traceTransfers.length > MAXIMUM_TRANSFERS
      ? undefined
      : input.traceTransfers,
    account
  )
  return Object.freeze([...(native === undefined ? [] : [native]), ...tokenRows])
}
