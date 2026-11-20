import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import type { SecurityJudgment } from '@/core/security/sensitive-operation-policy'

/** Shown once per PEA check. A saved allow would keep exposing that account. */
export const PEA_REMOTE_SECURITY_QUERY_CONSENT = Object.freeze({
  title: 'Check this with the security service?',
  message:
    'Private execution mode does not send this address, token, or site unless you allow this check. The allowance covers this check only.',
  confirmText: 'Allow this check',
  cancelText: 'Skip check'
})

export const REMOTE_SECURITY_QUERY_DELAY_MIN_MS = 300
export const REMOTE_SECURITY_QUERY_DELAY_MAX_MS = 1200

const MAX_ACCOUNT_ID_LENGTH = 256
const MAX_URL_LENGTH = 2048
const MAX_BODY_BYTES = 64 * 1024
const FORWARDED_HEADERS = new Set(['accept', 'content-type'])

export interface RemoteSecurityQuery {
  readonly accountId: string
  readonly executionMode: DAppExecutionMode
  readonly url: string
  readonly method?: 'GET' | 'POST'
  readonly body?: string | Uint8Array
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** Single-use, in-memory allowance. It is not written to extension storage. */
export interface RemoteSecurityConsent {
  readonly purpose: 'remote-security-query'
}

export type RemoteSecurityQuerySkipReason =
  | 'consent-required'
  | 'consent-mismatch'
  | 'consent-spent'

export type RemoteSecurityQueryResult =
  | { readonly status: 'skipped'; readonly reason: RemoteSecurityQuerySkipReason }
  | { readonly status: 'completed'; readonly response: Response }

export interface RemoteSecurityQueryDependencies {
  readonly fetch?: typeof fetch
  /** Random delay length. Defaults to the 300–1200ms privacy jitter. */
  readonly randomDelayMs?: () => number
  /** Clock used to wait out the jitter. Defaults to setTimeout. */
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface QueryBinding {
  readonly accountId: string
  readonly executionMode: DAppExecutionMode
  readonly method: 'GET' | 'POST'
  readonly url: string
  readonly bodySha256: string
}

interface PreparedQuery {
  readonly binding: QueryBinding
  readonly headers: Headers
  readonly body: Uint8Array<ArrayBuffer> | null
  readonly signal?: AbortSignal
}

const consents = new WeakMap<RemoteSecurityConsent, QueryBinding>()
const spentConsents = new WeakSet<RemoteSecurityConsent>()
const originTails = new Map<string, Promise<void>>()

export function remoteSecurityQueryDelayMs(nextUint32: () => number = randomUint32): number {
  const span = REMOTE_SECURITY_QUERY_DELAY_MAX_MS - REMOTE_SECURITY_QUERY_DELAY_MIN_MS + 1
  return REMOTE_SECURITY_QUERY_DELAY_MIN_MS + (nextUint32() % span)
}

function randomUint32(): number {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return values[0] ?? 0
}

/**
 * Records one private-mode allowance for this exact query.
 * Call it only after the user accepts {@link PEA_REMOTE_SECURITY_QUERY_CONSENT}.
 */
export async function grantRemoteSecurityQuery(
  query: RemoteSecurityQuery
): Promise<RemoteSecurityConsent> {
  const prepared = await prepareRemoteSecurityQuery(query)
  const consent: RemoteSecurityConsent = Object.freeze({ purpose: 'remote-security-query' })
  consents.set(consent, prepared.binding)
  return consent
}

/**
 * Sends one remote security lookup.
 * Private mode fetches only with a matching unspent consent. A skip stays unverified.
 */
export async function runRemoteSecurityQuery(
  query: RemoteSecurityQuery,
  consent: RemoteSecurityConsent | null,
  dependencies: RemoteSecurityQueryDependencies = {}
): Promise<RemoteSecurityQueryResult> {
  const prepared = await prepareRemoteSecurityQuery(query)
  const skip = consumeConsent(prepared.binding, consent)
  if (skip) return Object.freeze({ status: 'skipped', reason: skip })

  const response = await withOriginLane(new URL(prepared.binding.url).origin, async () => {
    const delay = dependencies.delay ?? waitForRemoteSecurityDelay
    const randomDelayMs = dependencies.randomDelayMs ?? remoteSecurityQueryDelayMs
    await delay(normalizeDelay(randomDelayMs()), prepared.signal)
    throwIfAborted(prepared.signal)
    const fetchImpl = dependencies.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new Error('Remote security query transport is unavailable')
    }
    const init: RequestInit = {
      method: prepared.binding.method,
      credentials: 'omit',
      cache: 'no-store',
      keepalive: false,
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: prepared.headers
    }
    if (prepared.body) init.body = prepared.body
    if (prepared.signal) init.signal = prepared.signal
    return fetchImpl(prepared.binding.url, init)
  })
  return Object.freeze({ status: 'completed', response })
}

/** A skipped PEA check is unverified. This gate does not turn a response into clear. */
export function remoteSecurityQueryJudgment(
  result: RemoteSecurityQueryResult
): SecurityJudgment | null {
  if (result.status === 'skipped') return 'unknown'
  return null
}

function consumeConsent(
  binding: QueryBinding,
  consent: RemoteSecurityConsent | null
): RemoteSecurityQuerySkipReason | null {
  if (binding.executionMode === 'main') return null
  if (consent === null) return 'consent-required'
  const granted = consents.get(consent)
  if (!granted) return 'consent-mismatch'
  if (spentConsents.has(consent)) return 'consent-spent'
  if (!sameBinding(granted, binding)) return 'consent-mismatch'
  spentConsents.add(consent)
  return null
}

function sameBinding(left: QueryBinding, right: QueryBinding): boolean {
  return (
    left.accountId === right.accountId &&
    left.executionMode === right.executionMode &&
    left.method === right.method &&
    left.url === right.url &&
    left.bodySha256 === right.bodySha256
  )
}

async function prepareRemoteSecurityQuery(query: RemoteSecurityQuery): Promise<PreparedQuery> {
  const accountId = readAccountId(query.accountId)
  const executionMode = readExecutionMode(query.executionMode)
  const method = readMethod(query.method)
  const url = readUrl(query.url, accountId)
  const body = readBody(method, query.body)
  const headers = readHeaders(query.headers, accountId)
  const binding: QueryBinding = Object.freeze({
    accountId,
    executionMode,
    method,
    url: url.href,
    bodySha256: await sha256Hex(body ?? new Uint8Array())
  })
  return query.signal
    ? { binding, headers, body, signal: query.signal }
    : { binding, headers, body }
}

function readAccountId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACCOUNT_ID_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error('Remote security query is invalid')
  }
  return value
}

function readExecutionMode(value: unknown): DAppExecutionMode {
  if (value === 'main' || value === 'private') return value
  throw new Error('Remote security query is invalid')
}

function readMethod(value: unknown): 'GET' | 'POST' {
  if (value === undefined || value === 'GET') return 'GET'
  if (value === 'POST') return 'POST'
  throw new Error('Remote security query is invalid')
}

function readUrl(value: unknown, accountId: string): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error('Remote security query is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Remote security query is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('Remote security query must use HTTPS')
  if (url.username !== '' || url.password !== '') {
    throw new Error('Remote security query cannot include credentials')
  }
  if (containsAccount(urlIdentityText(url, value), accountId)) {
    throw new Error('Remote security query cannot include the account')
  }
  return url
}

function urlIdentityText(url: URL, raw: string): string {
  const params: string[] = []
  url.searchParams.forEach((paramValue, name) => {
    params.push(name, paramValue)
  })
  return [raw, url.href, url.pathname, url.hash, ...params].join('\n')
}

function readBody(method: 'GET' | 'POST', value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value === undefined) return null
  if (method === 'GET') throw new Error('Remote security query is invalid')
  if (typeof value === 'string') return ownedBytes(new TextEncoder().encode(value))
  if (value instanceof Uint8Array) return ownedBytes(value)
  throw new Error('Remote security query is invalid')
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('Remote security query is invalid')
  const copy = new ArrayBuffer(bytes.byteLength)
  const owned = new Uint8Array(copy)
  owned.set(bytes)
  return owned
}

function readHeaders(value: unknown, accountId: string): Headers {
  if (value === undefined) return new Headers()
  if (!isPlainRecord(value)) throw new Error('Remote security query is invalid')
  const headers = new Headers()
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') throw new Error('Remote security query is invalid')
    if (containsAccount(name, accountId) || containsAccount(headerValue, accountId)) {
      throw new Error('Remote security query cannot include the account')
    }
    if (!FORWARDED_HEADERS.has(name.toLowerCase())) continue
    headers.set(name, headerValue)
  }
  return headers
}

function containsAccount(value: string, accountId: string): boolean {
  return value.toLowerCase().includes(accountId.toLowerCase())
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function normalizeDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('Remote security query is invalid')
  return ms
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Remote security query was cancelled')
}

function waitForRemoteSecurityDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Remote security query was cancelled'))
    }
    function finish() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Different accounts must not share an in-flight lookup on one origin.
 * The browser may still pool the underlying socket; this queue stops that
 * pool from carrying two accounts at the same time.
 */
async function withOriginLane<T>(origin: string, task: () => Promise<T>): Promise<T> {
  const previous = originTails.get(origin) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.then(
    () => current,
    () => current
  )
  originTails.set(origin, tail)
  try {
    await previous
    return await task()
  } finally {
    release()
    if (originTails.get(origin) === tail) originTails.delete(origin)
  }
}
