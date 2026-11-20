import { EvmRpcError } from './evm-rpc-client'
import { PERMIT2_CONTRACT } from './evm-contract-call-classification'
import {
  PERMIT2_APPROVAL_TOPIC,
  PERMIT2_PERMIT_TOPIC,
  permit2AllowanceExpired,
  type Permit2InternalAllowance
} from './evm-permit2-allowance'

const MAX_PAIRS = 256
const MAX_TOKENS = 64
const SEARCH_STEPS = 8
const LOG_CHUNKS = 2
const DEFAULT_CHUNK_SIZE = 2_000n
const MAX_UINT160 = (1n << 160n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n

export interface Permit2ScanStore {
  readonly read: () => Promise<unknown>
  readonly write: (value: unknown) => Promise<void>
}

export interface Permit2KnownToken {
  readonly chainId: string
  readonly contractAddress: string
  readonly symbol: string | null
  readonly decimals: number | null
  readonly trusted: boolean
}

export interface Permit2ChainTarget {
  readonly chainId: string
  readonly rpcOrigin: 'builtin' | 'user' | 'dapp'
}

export interface Permit2Log {
  readonly address: string
  readonly topics: readonly string[]
}

export interface Permit2ChainReader {
  readonly getBlockHeader: (
    block: 'latest' | string,
    signal: AbortSignal
  ) => Promise<{ readonly number: string; readonly timestamp: string }>
  readonly getCodeAt: (address: string, blockNumber: string, signal: AbortSignal) => Promise<string>
  readonly getLogs: (
    query: {
      readonly address: string
      readonly fromBlock: string
      readonly toBlock: string
      readonly topics: readonly (string | readonly string[])[]
    },
    signal: AbortSignal
  ) => Promise<readonly Permit2Log[]>
  readonly readErc20Allowance: (
    token: string,
    owner: string,
    spender: string,
    signal: AbortSignal
  ) => Promise<string>
  readonly readPermit2Allowance: (
    owner: string,
    token: string,
    spender: string,
    signal: AbortSignal
  ) => Promise<Permit2InternalAllowance>
}

export type Permit2AllowanceEntry =
  | {
      readonly kind: 'token-permit2'
      readonly token: string
      readonly amountRaw: string
      readonly unlimited: boolean
      readonly symbol: string | null
      readonly decimals: number | null
    }
  | {
      readonly kind: 'internal'
      readonly token: string
      readonly spender: string
      readonly amountRaw: string
      readonly expirationRaw: string
      readonly expired: boolean
      readonly unlimited: boolean
      readonly symbol: string | null
      readonly decimals: number | null
    }

export interface Permit2AllowanceChain {
  readonly chainId: string
  readonly rpcOrigin: 'builtin' | 'user' | 'dapp'
  readonly status: 'ready' | 'incomplete' | 'unavailable' | 'absent'
  readonly entries: readonly Permit2AllowanceEntry[]
}

export interface Permit2AllowanceResult {
  readonly available: boolean
  readonly chains: readonly Permit2AllowanceChain[]
}

export interface Permit2ScanCursor {
  readonly deploymentBlock: string
  readonly highCovered: string | null
  readonly lowPending: string | null
}

interface StoredPair {
  readonly token: string
  readonly spender: string
}

interface StoredChain {
  phase: 'search' | 'scan' | 'absent' | 'done'
  searchLow: string | null
  searchHigh: string | null
  deploymentBlock: string | null
  lowPending: string | null
  highCovered: string | null
  chunkSize: string
  pairs: StoredPair[]
  truncated: boolean
}

interface StoredSnapshot {
  readonly version: 1
  readonly networkMode: string
  readonly chains: Record<string, Record<string, StoredChain>>
}

let queue: Promise<void> = Promise.resolve()

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function permit2PairsFromLogs(
  logs: readonly Permit2Log[],
  owner: string
): readonly StoredPair[] {
  const ownerTopic = paddedAddress(owner)
  const pairs: StoredPair[] = []
  const seen = new Set<string>()
  for (const log of logs) {
    if (log.address.toLowerCase() !== PERMIT2_CONTRACT || log.topics.length !== 4) continue
    const [topic, ownerWord, tokenWord, spenderWord] = log.topics
    if (topic !== PERMIT2_APPROVAL_TOPIC && topic !== PERMIT2_PERMIT_TOPIC) continue
    if (ownerWord !== ownerTopic) continue
    const token = addressFromTopic(tokenWord!)
    const spender = addressFromTopic(spenderWord!)
    if (!token || !spender) continue
    const key = `${token}:${spender}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push(Object.freeze({ token, spender }))
  }
  return Object.freeze(pairs)
}

/** Recent blocks are scanned before older history so current spenders appear first. */
export function nextPermit2ScanRange(
  cursor: Permit2ScanCursor,
  latest: bigint,
  chunkSize: bigint
): { readonly from: bigint; readonly to: bigint; readonly kind: 'tip' | 'history' } | null {
  const deployment = BigInt(cursor.deploymentBlock)
  if (chunkSize < 1n || latest < deployment) return null
  const highCovered = cursor.highCovered === null ? null : BigInt(cursor.highCovered)
  if (highCovered !== null && latest > highCovered) {
    const from = highCovered + 1n
    return {
      from,
      to: latest < from + chunkSize - 1n ? latest : from + chunkSize - 1n,
      kind: 'tip'
    }
  }
  if (highCovered === null) {
    return {
      from: latest - chunkSize + 1n < deployment ? deployment : latest - chunkSize + 1n,
      to: latest,
      kind: 'history'
    }
  }
  const pending = cursor.lowPending === null ? highCovered : BigInt(cursor.lowPending)
  if (pending < deployment) return null
  const to = pending < latest ? pending : latest
  if (to < deployment) return null
  return {
    from: to - chunkSize + 1n < deployment ? deployment : to - chunkSize + 1n,
    to,
    kind: 'history'
  }
}

export async function collectPermit2Allowances(input: {
  readonly signal: AbortSignal
  readonly networkMode: string
  readonly owner: string
  readonly chains: readonly Permit2ChainTarget[]
  readonly tokens: readonly Permit2KnownToken[]
  readonly store: Permit2ScanStore
  readonly reader: (chainId: string) => Permit2ChainReader | null
}): Promise<readonly Permit2AllowanceChain[]> {
  return exclusive(() => collectExclusive(input))
}

async function collectExclusive(input: {
  readonly signal: AbortSignal
  readonly networkMode: string
  readonly owner: string
  readonly chains: readonly Permit2ChainTarget[]
  readonly tokens: readonly Permit2KnownToken[]
  readonly store: Permit2ScanStore
  readonly reader: (chainId: string) => Permit2ChainReader | null
}): Promise<readonly Permit2AllowanceChain[]> {
  throwIfAborted(input.signal)
  const owner = input.owner.toLowerCase()
  const snapshot = parseSnapshot(await input.store.read(), input.networkMode)
  const advanceId =
    input.chains.find(chain => {
      const stored = snapshot.chains[chain.chainId]?.[owner]
      return !stored || (stored.phase !== 'done' && stored.phase !== 'absent')
    })?.chainId ?? null
  const chains: Permit2AllowanceChain[] = []
  let changed = false
  for (const target of input.chains) {
    throwIfAborted(input.signal)
    const reader = input.reader(target.chainId)
    const existing = snapshot.chains[target.chainId]?.[owner]
    const stored = existing ?? emptyChain()
    if (!existing && target.chainId === advanceId) {
      const owners = snapshot.chains[target.chainId] ?? (snapshot.chains[target.chainId] = {})
      owners[owner] = stored
    }
    if (!reader) {
      chains.push(chainResult(target, 'unavailable', []))
      continue
    }
    let advanceFailed = false
    if (target.chainId === advanceId && stored.phase !== 'absent' && stored.phase !== 'done') {
      try {
        changed = (await advanceChain(stored, reader, owner, input.signal)) || changed
      } catch (error) {
        if (input.signal.aborted || isAbort(error)) throw abortError()
        advanceFailed = true
        changed = true
      }
    }
    if (stored.phase === 'absent') {
      chains.push(chainResult(target, 'absent', []))
      continue
    }
    const entries = await readEntries(
      reader,
      owner,
      stored,
      input.tokens.filter(token => token.chainId === target.chainId).slice(0, MAX_TOKENS),
      input.signal
    )
    const scanning = stored.phase !== 'done' || stored.truncated || advanceFailed
    chains.push(
      chainResult(
        target,
        entries === null ? 'unavailable' : scanning ? 'incomplete' : 'ready',
        entries ?? []
      )
    )
  }
  if (changed) {
    throwIfAborted(input.signal)
    await input.store.write(snapshot)
  }
  return Object.freeze(chains)
}

async function advanceChain(
  state: StoredChain,
  reader: Permit2ChainReader,
  owner: string,
  signal: AbortSignal
): Promise<boolean> {
  if (state.phase === 'search') {
    if (state.searchHigh === null || state.searchLow === null) {
      const latest = await reader.getBlockHeader('latest', signal)
      const code = await reader.getCodeAt(PERMIT2_CONTRACT, latest.number, signal)
      if (!hasRuntimeCode(code)) {
        state.phase = 'absent'
        return true
      }
      state.searchLow = '0'
      state.searchHigh = latest.number
    }
    for (let step = 0; step < SEARCH_STEPS; step += 1) {
      throwIfAborted(signal)
      const low: bigint = BigInt(state.searchLow!)
      const high: bigint = BigInt(state.searchHigh!)
      if (low === high) {
        state.deploymentBlock = low.toString()
        state.phase = 'scan'
        state.searchLow = null
        state.searchHigh = null
        break
      }
      const mid: bigint = (low + high) / 2n
      const code = await reader.getCodeAt(PERMIT2_CONTRACT, mid.toString(), signal)
      if (hasRuntimeCode(code)) state.searchHigh = mid.toString()
      else state.searchLow = (mid + 1n).toString()
    }
    if (state.phase !== 'scan') return true
  }

  let progressed = false
  for (let chunk = 0; chunk < LOG_CHUNKS; chunk += 1) {
    throwIfAborted(signal)
    if (state.phase !== 'scan' || state.deploymentBlock === null) return progressed
    const latest = await reader.getBlockHeader('latest', signal)
    const range = nextPermit2ScanRange(
      {
        deploymentBlock: state.deploymentBlock,
        highCovered: state.highCovered,
        lowPending: state.lowPending
      },
      BigInt(latest.number),
      BigInt(state.chunkSize)
    )
    if (!range) {
      state.phase = 'done'
      return true
    }
    try {
      const logs = await reader.getLogs(
        {
          address: PERMIT2_CONTRACT,
          fromBlock: range.from.toString(),
          toBlock: range.to.toString(),
          topics: [[PERMIT2_APPROVAL_TOPIC, PERMIT2_PERMIT_TOPIC], paddedAddress(owner)]
        },
        signal
      )
      mergePairs(state, permit2PairsFromLogs(logs, owner))
      applyRange(state, range)
      progressed = true
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw abortError()
      if (!isSplittableLogError(error)) throw error
      const size = BigInt(state.chunkSize)
      if (size > 1n) {
        state.chunkSize = (size / 2n).toString()
        return true
      }
      state.truncated = true
      applyRange(state, range)
      return true
    }
  }
  return progressed
}

function applyRange(
  state: StoredChain,
  range: { readonly from: bigint; readonly to: bigint; readonly kind: 'tip' | 'history' }
): void {
  if (range.kind === 'tip') {
    state.highCovered = range.to.toString()
    return
  }
  if (state.highCovered === null) state.highCovered = range.to.toString()
  state.lowPending = (range.from - 1n).toString()
}

async function readEntries(
  reader: Permit2ChainReader,
  owner: string,
  state: StoredChain,
  tokens: readonly Permit2KnownToken[],
  signal: AbortSignal
): Promise<readonly Permit2AllowanceEntry[] | null> {
  let header: { readonly number: string; readonly timestamp: string }
  try {
    header = await reader.getBlockHeader('latest', signal)
  } catch (error) {
    if (signal.aborted || isAbort(error)) throw abortError()
    return null
  }
  const tokenSet = new Map<string, Permit2KnownToken>()
  for (const token of tokens.slice(0, MAX_TOKENS)) {
    tokenSet.set(token.contractAddress.toLowerCase(), token)
  }
  for (const pair of state.pairs) {
    if (tokenSet.has(pair.token)) continue
    tokenSet.set(pair.token, {
      chainId: '',
      contractAddress: pair.token,
      symbol: null,
      decimals: null,
      trusted: false
    })
  }
  const contracts = [...tokenSet.values()]
  let failures = 0
  const master = await mapLimited(contracts, 4, async token => {
    try {
      const amountRaw = await reader.readErc20Allowance(
        token.contractAddress,
        owner,
        PERMIT2_CONTRACT,
        signal
      )
      return { token, amountRaw }
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw abortError()
      failures += 1
      return null
    }
  })
  const internal = await mapLimited(state.pairs, 4, async pair => {
    try {
      const allowance = await reader.readPermit2Allowance(owner, pair.token, pair.spender, signal)
      return { pair, allowance }
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw abortError()
      failures += 1
      return null
    }
  })
  if (
    failures > 0 &&
    master.every(item => item === null) &&
    internal.every(item => item === null)
  ) {
    return contracts.length === 0 && state.pairs.length === 0 ? [] : null
  }
  const entries: Permit2AllowanceEntry[] = []
  for (const item of master) {
    if (!item || BigInt(item.amountRaw) === 0n) continue
    const trusted = item.token.trusted ? item.token : null
    entries.push(
      Object.freeze({
        kind: 'token-permit2',
        token: item.token.contractAddress.toLowerCase(),
        amountRaw: item.amountRaw,
        unlimited: BigInt(item.amountRaw) === MAX_UINT256,
        symbol: trusted?.symbol ?? null,
        decimals: trusted?.decimals ?? null
      })
    )
  }
  for (const item of internal) {
    if (!item || BigInt(item.allowance.amountRaw) === 0n) continue
    const known = tokenSet.get(item.pair.token)
    const trusted = known?.trusted ? known : null
    entries.push(
      Object.freeze({
        kind: 'internal',
        token: item.pair.token,
        spender: item.pair.spender,
        amountRaw: item.allowance.amountRaw,
        expirationRaw: item.allowance.expirationRaw,
        expired: permit2AllowanceExpired(item.allowance.expirationRaw, header.timestamp),
        unlimited: BigInt(item.allowance.amountRaw) === MAX_UINT160,
        symbol: trusted?.symbol ?? null,
        decimals: trusted?.decimals ?? null
      })
    )
  }
  return Object.freeze(entries)
}

function mergePairs(state: StoredChain, pairs: readonly StoredPair[]): void {
  const seen = new Set(state.pairs.map(pair => `${pair.token}:${pair.spender}`))
  for (const pair of pairs) {
    const key = `${pair.token}:${pair.spender}`
    if (seen.has(key)) continue
    if (state.pairs.length >= MAX_PAIRS) {
      state.truncated = true
      return
    }
    seen.add(key)
    state.pairs.push(pair)
  }
}

function emptyChain(): StoredChain {
  return {
    phase: 'search',
    searchLow: null,
    searchHigh: null,
    deploymentBlock: null,
    lowPending: null,
    highCovered: null,
    chunkSize: DEFAULT_CHUNK_SIZE.toString(),
    pairs: [],
    truncated: false
  }
}

function chainResult(
  target: Permit2ChainTarget,
  status: Permit2AllowanceChain['status'],
  entries: readonly Permit2AllowanceEntry[]
): Permit2AllowanceChain {
  return Object.freeze({
    chainId: target.chainId,
    rpcOrigin: target.rpcOrigin,
    status,
    entries: Object.freeze(entries)
  })
}

function parseSnapshot(value: unknown, networkMode: string): StoredSnapshot {
  const empty = (): StoredSnapshot => ({ version: 1, networkMode, chains: {} })
  if (!isRecord(value) || value.version !== 1 || value.networkMode !== networkMode) return empty()
  if (!isRecord(value.chains)) return empty()
  const chains: Record<string, Record<string, StoredChain>> = {}
  for (const [chainId, owners] of Object.entries(value.chains)) {
    if (!isRecord(owners)) continue
    const parsedOwners: Record<string, StoredChain> = {}
    for (const [owner, stored] of Object.entries(owners)) {
      const chain = parseStoredChain(stored)
      if (chain && /^0x[0-9a-f]{40}$/.test(owner)) parsedOwners[owner] = chain
    }
    if (/^eip155:[0-9]+$/.test(chainId)) chains[chainId] = parsedOwners
  }
  return { version: 1, networkMode, chains }
}

function parseStoredChain(value: unknown): StoredChain | null {
  if (!isRecord(value)) return null
  if (
    value.phase !== 'search' &&
    value.phase !== 'scan' &&
    value.phase !== 'absent' &&
    value.phase !== 'done'
  ) {
    return null
  }
  if (typeof value.chunkSize !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value.chunkSize)) return null
  if (typeof value.truncated !== 'boolean' || !Array.isArray(value.pairs)) return null
  const pairs: StoredPair[] = []
  for (const pair of value.pairs) {
    if (
      !isRecord(pair) ||
      typeof pair.token !== 'string' ||
      typeof pair.spender !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(pair.token) ||
      !/^0x[0-9a-f]{40}$/.test(pair.spender)
    ) {
      return null
    }
    pairs.push(Object.freeze({ token: pair.token, spender: pair.spender }))
  }
  const cursor = (key: string, allowNegative: boolean): string | null | undefined => {
    const field = value[key]
    if (field === null) return null
    if (typeof field !== 'string') return undefined
    if (allowNegative && field === '-1') return field
    return /^(0|[1-9][0-9]{0,20})$/.test(field) ? field : undefined
  }
  const searchLow = cursor('searchLow', false)
  const searchHigh = cursor('searchHigh', false)
  const deploymentBlock = cursor('deploymentBlock', false)
  const lowPending = cursor('lowPending', true)
  const highCovered = cursor('highCovered', false)
  if (
    searchLow === undefined ||
    searchHigh === undefined ||
    deploymentBlock === undefined ||
    lowPending === undefined ||
    highCovered === undefined
  ) {
    return null
  }
  if (
    value.phase === 'scan' &&
    (deploymentBlock === null || (highCovered === null && lowPending !== null))
  ) {
    return null
  }
  return {
    phase: value.phase,
    searchLow,
    searchHigh,
    deploymentBlock,
    lowPending,
    highCovered,
    chunkSize: value.chunkSize,
    pairs,
    truncated: value.truncated
  }
}

export function parsePermit2AllowanceResult(value: unknown): Permit2AllowanceResult {
  const result = readRecord(value, 'Permit2 allowance result')
  assertExactKeys(result, ['available', 'chains'], 'Permit2 allowance result')
  if (typeof result.available !== 'boolean' || !Array.isArray(result.chains)) {
    throw new Error('Invalid Permit2 allowance result')
  }
  if (!result.available && result.chains.length !== 0) {
    throw new Error('Invalid Permit2 allowance result')
  }
  if (result.chains.length > 64) throw new Error('Invalid Permit2 allowance result')
  const chains = result.chains.map(chain => parseChain(chain))
  if (new Set(chains.map(chain => chain.chainId)).size !== chains.length) {
    throw new Error('Invalid Permit2 allowance result')
  }
  return Object.freeze({ available: result.available, chains: Object.freeze(chains) })
}

function parseChain(value: unknown): Permit2AllowanceChain {
  const chain = readRecord(value, 'Permit2 allowance chain')
  assertExactKeys(chain, ['chainId', 'rpcOrigin', 'status', 'entries'], 'Permit2 allowance chain')
  if (typeof chain.chainId !== 'string' || !/^eip155:(0|[1-9][0-9]{0,19})$/.test(chain.chainId)) {
    throw new Error('Invalid Permit2 allowance chain')
  }
  if (chain.rpcOrigin !== 'builtin' && chain.rpcOrigin !== 'user' && chain.rpcOrigin !== 'dapp') {
    throw new Error('Invalid Permit2 allowance chain')
  }
  if (
    chain.status !== 'ready' &&
    chain.status !== 'incomplete' &&
    chain.status !== 'unavailable' &&
    chain.status !== 'absent'
  ) {
    throw new Error('Invalid Permit2 allowance chain')
  }
  if (!Array.isArray(chain.entries) || chain.entries.length > MAX_PAIRS + MAX_TOKENS) {
    throw new Error('Invalid Permit2 allowance chain')
  }
  return Object.freeze({
    chainId: chain.chainId,
    rpcOrigin: chain.rpcOrigin,
    status: chain.status,
    entries: Object.freeze(chain.entries.map(entry => parseEntry(entry)))
  })
}

function parseEntry(value: unknown): Permit2AllowanceEntry {
  const entry = readRecord(value, 'Permit2 allowance entry')
  const symbol = entry.symbol === null ? null : readSymbol(entry.symbol)
  const decimals =
    entry.decimals === null
      ? null
      : typeof entry.decimals === 'number' &&
          Number.isInteger(entry.decimals) &&
          entry.decimals >= 0 &&
          entry.decimals <= 255
        ? entry.decimals
        : null
  if (decimals === null && entry.decimals !== null)
    throw new Error('Invalid Permit2 allowance entry')
  if (typeof entry.token !== 'string' || !/^0x[0-9a-f]{40}$/.test(entry.token)) {
    throw new Error('Invalid Permit2 allowance entry')
  }
  if (typeof entry.amountRaw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(entry.amountRaw)) {
    throw new Error('Invalid Permit2 allowance entry')
  }
  if (typeof entry.unlimited !== 'boolean') throw new Error('Invalid Permit2 allowance entry')
  if (entry.kind === 'token-permit2') {
    assertExactKeys(
      entry,
      ['kind', 'token', 'amountRaw', 'unlimited', 'symbol', 'decimals'],
      'Permit2 allowance entry'
    )
    return Object.freeze({
      kind: 'token-permit2',
      token: entry.token,
      amountRaw: entry.amountRaw,
      unlimited: entry.unlimited,
      symbol,
      decimals
    })
  }
  if (entry.kind !== 'internal') throw new Error('Invalid Permit2 allowance entry')
  assertExactKeys(
    entry,
    [
      'kind',
      'token',
      'spender',
      'amountRaw',
      'expirationRaw',
      'expired',
      'unlimited',
      'symbol',
      'decimals'
    ],
    'Permit2 allowance entry'
  )
  if (
    typeof entry.spender !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(entry.spender) ||
    typeof entry.expirationRaw !== 'string' ||
    !/^(0|[1-9][0-9]{0,14})$/.test(entry.expirationRaw) ||
    typeof entry.expired !== 'boolean'
  ) {
    throw new Error('Invalid Permit2 allowance entry')
  }
  return Object.freeze({
    kind: 'internal',
    token: entry.token,
    spender: entry.spender,
    amountRaw: entry.amountRaw,
    expirationRaw: entry.expirationRaw,
    expired: entry.expired,
    unlimited: entry.unlimited,
    symbol,
    decimals
  })
}

function readSymbol(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32) {
    throw new Error('Invalid Permit2 allowance entry')
  }
  return value
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function paddedAddress(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
}

function addressFromTopic(topic: string): string | null {
  return /^0x0{24}[0-9a-f]{40}$/.test(topic) ? `0x${topic.slice(26)}` : null
}

function hasRuntimeCode(code: string): boolean {
  return code.toLowerCase() !== '0x'
}

function isSplittableLogError(error: unknown): boolean {
  return (
    error instanceof EvmRpcError &&
    (error.code === 'invalid-response' ||
      error.code === 'rpc-error' ||
      error.code === 'rate-limited' ||
      error.code === 'timeout')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
