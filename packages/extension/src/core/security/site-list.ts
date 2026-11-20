import { ed25519 } from '@noble/curves/ed25519'

const MAX_ENTRY_LENGTH = 2_048
const MAX_PUBLISHED_ENTRIES = 10_000
const MAX_DOCUMENTS = 3
const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SIGNATURE = /^[0-9a-f]{128}$/
const ROLES = ['metamask-mirror', 'emergency', 'exception'] as const

export type SiteListKind = 'hostname' | 'ip' | 'path'
export type SiteListRole = (typeof ROLES)[number]
export type SiteListStatus = 'unavailable' | 'current' | 'list-expired'
export type SiteListBlockKind = 'hard' | 'list'
export type SiteRisk = 'block' | 'warn' | 'unknown' | 'clear'

export const SITE_LIST_EXPIRED_LABEL = 'Site list expired'

export interface ClassifiedSiteListEntry {
  readonly kind: SiteListKind
  readonly value: string
}

export interface PublishedSiteList {
  readonly version: 1
  readonly hostnames: readonly string[]
  readonly ips: readonly string[]
}

export interface SplitSiteList extends PublishedSiteList {
  readonly paths: readonly string[]
}

export interface SiteListSnapshot {
  readonly hostnames: readonly string[]
  readonly ips: readonly string[]
  readonly paths: readonly string[]
}

export interface SiteListPublicKey {
  readonly id: string
  readonly publicKey: Uint8Array
}

export interface SiteListKeySlot {
  readonly current: SiteListPublicKey
  readonly next: SiteListPublicKey
}

/** Public keys only. Private keys stay with the publishers. */
export interface SiteListKeyRegistry {
  readonly auto: SiteListKeySlot | null
  readonly reviewed: SiteListKeySlot | null
}

/**
 * Release builds fill the current and next public keys.
 * An empty slot rejects every remote document for that role.
 * With no keys configured, there is no remote list to load.
 */
export const SITE_LIST_KEYS: SiteListKeyRegistry = {
  auto: null,
  reviewed: null
}

/** True when at least one publisher role has current and next public keys. */
export function siteListKeysProvisioned(keys: SiteListKeyRegistry): boolean {
  return keys.auto !== null || keys.reviewed !== null
}

export interface SiteListHostSet {
  readonly hostnames: readonly string[]
  readonly ips: readonly string[]
}

export interface SignedSiteListDocument {
  readonly role: SiteListRole
  readonly keyId: string
  readonly version: number
  readonly expiresAt: number
  readonly hostnames: readonly string[]
  readonly ips: readonly string[]
  readonly signature: string
}

export interface SiteListAssessment {
  readonly status: SiteListStatus
  readonly label: typeof SITE_LIST_EXPIRED_LABEL | null
  readonly mirror: SiteListHostSet
  readonly emergency: SiteListHostSet
  readonly exceptions: SiteListHostSet
}

interface DocumentBody {
  readonly role: SiteListRole
  readonly keyId: string
  readonly version: number
  readonly expiresAt: number
  readonly hostnames: readonly string[]
  readonly ips: readonly string[]
}

const EMPTY_HOSTS: SiteListHostSet = { hostnames: [], ips: [] }
const SITE_RISK_RANK: Record<SiteRisk, number> = {
  block: 3,
  warn: 2,
  unknown: 1,
  clear: 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHttpUrl(value: string): URL | null {
  if (value.length === 0 || value.length > MAX_ENTRY_LENGTH) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username.length > 0 || url.password.length > 0) {
    return null
  }
  if (url.hostname.length === 0) return null
  return url
}

/** WHATWG URL host serialization is UTS-46 non-transitional punycode. */
function canonicalHost(url: URL): string | null {
  const stripped = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname
  if (stripped.length === 0) return null
  if (stripped === url.hostname) return stripped
  let again: URL
  try {
    again = new URL(`https://${stripped}/`)
  } catch {
    return null
  }
  if (
    again.username.length > 0 ||
    again.password.length > 0 ||
    again.pathname !== '/' ||
    again.hostname !== stripped
  ) {
    return null
  }
  return again.hostname
}

function isIpHostname(hostname: string): boolean {
  if (hostname.startsWith('[')) return hostname.endsWith(']') && hostname.includes(':')
  return /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname)
}

function pathPrefix(url: URL, host: string): string | null {
  const pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.length === 0) return null
  const authority = url.port.length > 0 ? `${host}:${url.port}` : host
  return `${url.protocol}//${authority}${pathname}`
}

export function isSiteListCandidate(value: string): boolean {
  return typeof value === 'string' && parseHttpUrl(value) !== null
}

/** Scheme and non-default port stay in the key. Path, query, and fragment do not. */
export function originCacheKey(value: string): string | null {
  if (typeof value !== 'string') return null
  return parseHttpUrl(value)?.origin ?? null
}

export function classifyListEntry(value: string): ClassifiedSiteListEntry | null {
  const url = parseHttpUrl(value)
  if (!url) return null
  const host = canonicalHost(url)
  if (!host) return null
  // A path entry stays a path. Its host is not also published as a hostname or IP.
  const prefix = pathPrefix(url, host)
  if (prefix) return { kind: 'path', value: prefix }
  if (isIpHostname(host)) return { kind: 'ip', value: host }
  return { kind: 'hostname', value: host }
}

function classifyBareHost(value: string, kind: 'hostname' | 'ip'): string | null {
  const entry = value.includes('://') ? value : `https://${value}/`
  const classified = classifyListEntry(entry)
  if (!classified || classified.kind !== kind) return null
  return classified.value
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

export function splitListEntries(entries: readonly string[]): SplitSiteList {
  const hostnames: string[] = []
  const ips: string[] = []
  const paths: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const classified = classifyListEntry(entry)
    if (!classified) continue
    if (classified.kind === 'path') paths.push(classified.value)
    else if (classified.kind === 'ip') ips.push(classified.value)
    else hostnames.push(classified.value)
  }
  return {
    version: 1,
    hostnames: sortedUnique(hostnames),
    ips: sortedUnique(ips),
    paths: sortedUnique(paths)
  }
}

export function publishSiteList(entries: readonly string[]): PublishedSiteList {
  const split = splitListEntries(entries)
  return { version: 1, hostnames: split.hostnames, ips: split.ips }
}

export function readPublishedSiteList(value: unknown): PublishedSiteList | null {
  if (!isRecord(value) || value.version !== 1) return null
  const keys = Object.keys(value)
  if (keys.some(key => key !== 'version' && key !== 'hostnames' && key !== 'ips')) return null
  if (!Array.isArray(value.hostnames) || !Array.isArray(value.ips)) return null
  if (value.hostnames.length > MAX_PUBLISHED_ENTRIES || value.ips.length > MAX_PUBLISHED_ENTRIES) {
    return null
  }
  const hostnames: string[] = []
  const ips: string[] = []
  for (const entry of value.hostnames) {
    if (typeof entry !== 'string' || entry.length > MAX_ENTRY_LENGTH) return null
    const hostname = classifyBareHost(entry, 'hostname')
    if (hostname) hostnames.push(hostname)
  }
  for (const entry of value.ips) {
    if (typeof entry !== 'string' || entry.length > MAX_ENTRY_LENGTH) return null
    const ip = classifyBareHost(entry, 'ip')
    if (ip) ips.push(ip)
  }
  return { version: 1, hostnames: sortedUnique(hostnames), ips: sortedUnique(ips) }
}

function sameListedHost(candidate: string, entry: string, kind: 'hostname' | 'ip'): boolean {
  if (entry === candidate) return true
  return classifyBareHost(entry, kind) === candidate
}

export function matchListedSite(candidate: string, list: SiteListSnapshot): boolean {
  if (typeof candidate !== 'string') return false
  const url = parseHttpUrl(candidate)
  if (!url) return false
  const host = canonicalHost(url)
  if (!host) return false
  const prefix = pathPrefix(url, host)
  if (prefix) {
    for (const entry of list.paths) {
      if (prefix === entry || prefix.startsWith(`${entry}/`)) return true
    }
  }
  if (isIpHostname(host)) {
    for (const entry of list.ips) {
      if (sameListedHost(host, entry, 'ip')) return true
    }
    return false
  }
  for (const entry of list.hostnames) {
    if (sameListedHost(host, entry, 'hostname')) return true
  }
  return false
}

function canonicalJson(value: unknown): string | null {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      const encoded = canonicalJson(item)
      if (encoded === null) return null
      parts.push(encoded)
    }
    return `[${parts.join(',')}]`
  }
  if (!isRecord(value)) return null
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const encoded = canonicalJson(value[key])
    if (encoded === null) return null
    parts.push(`${JSON.stringify(key)}:${encoded}`)
  }
  return `{${parts.join(',')}}`
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  if (actual.length !== keys.length) return false
  return keys.every(key => actual.includes(key))
}

function exactHostEntries(values: unknown, kind: 'hostname' | 'ip'): readonly string[] | null {
  if (!Array.isArray(values) || values.length > MAX_PUBLISHED_ENTRIES) return null
  const entries: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENTRY_LENGTH) {
      return null
    }
    const classified = classifyListEntry(`https://${value}/`)
    if (!classified || classified.kind !== kind || classified.value !== value) return null
    entries.push(value)
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]! >= entries[index]!) return null
  }
  return entries
}

function documentBody(value: unknown): DocumentBody | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['expiresAt', 'hostnames', 'ips', 'keyId', 'role', 'signature', 'version'])
  ) {
    return null
  }
  if (
    !ROLES.includes(value.role as SiteListRole) ||
    typeof value.keyId !== 'string' ||
    !KEY_ID.test(value.keyId) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) < 0 ||
    typeof value.signature !== 'string' ||
    !SIGNATURE.test(value.signature)
  ) {
    return null
  }
  const hostnames = exactHostEntries(value.hostnames, 'hostname')
  const ips = exactHostEntries(value.ips, 'ip')
  if (!hostnames || !ips) return null
  return {
    role: value.role as SiteListRole,
    keyId: value.keyId,
    version: value.version as number,
    expiresAt: value.expiresAt as number,
    hostnames,
    ips
  }
}

function signedPayload(body: DocumentBody): string | null {
  return canonicalJson({
    expiresAt: body.expiresAt,
    hostnames: body.hostnames,
    ips: body.ips,
    keyId: body.keyId,
    role: body.role,
    version: body.version
  })
}

function embeddedKey(key: SiteListPublicKey): SiteListPublicKey | null {
  if (!KEY_ID.test(key.id) || key.publicKey.length !== 32) return null
  return key
}

function keySlot(slot: SiteListKeySlot | null): SiteListKeySlot | null {
  if (!slot) return null
  const current = embeddedKey(slot.current)
  const next = embeddedKey(slot.next)
  if (!current || !next || current.id === next.id) return null
  return { current, next }
}

function publicKeyFor(
  role: SiteListRole,
  keyId: string,
  keys: SiteListKeyRegistry
): Uint8Array | null {
  const slot = keySlot(role === 'metamask-mirror' ? keys.auto : keys.reviewed)
  if (!slot) return null
  if (slot.current.id === keyId) return slot.current.publicKey
  if (slot.next.id === keyId) return slot.next.publicKey
  return null
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function signatureMatches(payload: string, signature: string, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(hexToBytes(signature), new TextEncoder().encode(payload), publicKey, {
      zip215: false
    })
  } catch {
    return false
  }
}

export function signSiteListDocument(
  body: DocumentBody,
  privateKey: Uint8Array
): SignedSiteListDocument {
  const payload = signedPayload(body)
  const hostnames = exactHostEntries(body.hostnames, 'hostname')
  const ips = exactHostEntries(body.ips, 'ip')
  if (
    !payload ||
    !hostnames ||
    !ips ||
    privateKey.length !== 32 ||
    !ROLES.includes(body.role) ||
    !KEY_ID.test(body.keyId) ||
    !Number.isSafeInteger(body.version) ||
    body.version < 1 ||
    !Number.isSafeInteger(body.expiresAt) ||
    body.expiresAt < 0
  ) {
    throw new Error('Site list document cannot be signed')
  }
  return {
    role: body.role,
    keyId: body.keyId,
    version: body.version,
    expiresAt: body.expiresAt,
    hostnames,
    ips,
    signature: bytesToHex(ed25519.sign(new TextEncoder().encode(payload), privateKey))
  }
}

export function verifySiteListDocument(
  value: unknown,
  keys: SiteListKeyRegistry
): SignedSiteListDocument | null {
  const body = documentBody(value)
  if (!body || !isRecord(value) || typeof value.signature !== 'string') return null
  const payload = signedPayload(body)
  const publicKey = publicKeyFor(body.role, body.keyId, keys)
  if (!payload || !publicKey || !signatureMatches(payload, value.signature, publicKey)) return null
  return {
    role: body.role,
    keyId: body.keyId,
    version: body.version,
    expiresAt: body.expiresAt,
    hostnames: body.hostnames,
    ips: body.ips,
    signature: value.signature
  }
}

export function canonicalSiteListPublication(
  documents: readonly SignedSiteListDocument[]
): string | null {
  return canonicalJson({ documents })
}

export function parseSiteListPublication(
  raw: string,
  keys: SiteListKeyRegistry
): readonly SignedSiteListDocument[] | null {
  if (raw.length === 0 || raw.length > 1_048_576) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (canonicalJson(parsed) !== raw || !isRecord(parsed) || !exactKeys(parsed, ['documents'])) {
    return null
  }
  if (!Array.isArray(parsed.documents) || parsed.documents.length > MAX_DOCUMENTS) return null
  const documents: SignedSiteListDocument[] = []
  const roles = new Set<SiteListRole>()
  for (const entry of parsed.documents) {
    const document = verifySiteListDocument(entry, keys)
    if (!document || roles.has(document.role)) return null
    roles.add(document.role)
    documents.push(document)
  }
  return documents
}

export function selectSiteListDocuments(
  current: readonly SignedSiteListDocument[],
  incoming: readonly SignedSiteListDocument[]
): readonly SignedSiteListDocument[] {
  const selected = new Map<SiteListRole, SignedSiteListDocument>()
  for (const document of current) selected.set(document.role, document)
  for (const document of incoming) {
    const previous = selected.get(document.role)
    if (!previous || document.version >= previous.version) selected.set(document.role, document)
  }
  return ROLES.flatMap(role => {
    const document = selected.get(role)
    return document ? [document] : []
  })
}

function latestDocument(
  documents: readonly SignedSiteListDocument[],
  role: SiteListRole
): SignedSiteListDocument | null {
  let selected: SignedSiteListDocument | null = null
  for (const document of documents) {
    if (document.role !== role) continue
    if (!selected || document.version >= selected.version) selected = document
  }
  return selected
}

function hostSet(document: SignedSiteListDocument | null): SiteListHostSet {
  if (!document) return EMPTY_HOSTS
  return { hostnames: document.hostnames, ips: document.ips }
}

export function assessSiteList(
  documents: readonly SignedSiteListDocument[],
  now: number
): SiteListAssessment {
  const mirror = latestDocument(documents, 'metamask-mirror')
  const emergency = latestDocument(documents, 'emergency')
  const exception = latestDocument(documents, 'exception')
  const blocking = [mirror, emergency].filter(document => document !== null)
  const clock = Number.isSafeInteger(now) ? now : Number.POSITIVE_INFINITY
  const status: SiteListStatus =
    blocking.length === 0
      ? 'unavailable'
      : blocking.some(document => clock >= document.expiresAt)
        ? 'list-expired'
        : 'current'
  const exceptionActive = status === 'current' && exception !== null && clock < exception.expiresAt
  return {
    status,
    label: status === 'list-expired' ? SITE_LIST_EXPIRED_LABEL : null,
    mirror: hostSet(mirror),
    emergency: hostSet(emergency),
    exceptions: exceptionActive ? hostSet(exception) : EMPTY_HOSTS
  }
}

/**
 * A remote result can only raise risk.
 * `clear` and `unknown` leave the local level unchanged, so a remote miss cannot
 * turn a cold start into `clear` or lower `block` or `warn`.
 * `warn` raises only `clear`. `block` raises every lower level.
 */
export function mergeSiteRisk(local: SiteRisk, remote: SiteRisk): SiteRisk {
  if (remote === 'block') return 'block'
  if (remote === 'warn' && local === 'clear') return 'warn'
  return local
}

/** Same-class results keep the higher level. */
export function higherSiteRisk(left: SiteRisk, right: SiteRisk): SiteRisk {
  return SITE_RISK_RANK[left] >= SITE_RISK_RANK[right] ? left : right
}

export function matchSiteListException(candidate: string, assessment: SiteListAssessment): boolean {
  if (assessment.status !== 'current') return false
  return matchListedSite(candidate, { ...assessment.exceptions, paths: [] })
}

/**
 * Local paths and the emergency list are hard blocks.
 * A mirror hit is a list block unless a current exception covers that host.
 * An exception removes neither an emergency match nor a local path match.
 * A miss stays null while the list is unloaded; that is not a block.
 */
export function classifySiteListBlock(
  candidate: string,
  assessment: SiteListAssessment,
  paths: readonly string[]
): SiteListBlockKind | null {
  if (matchListedSite(candidate, { hostnames: [], ips: [], paths })) return 'hard'
  if (matchListedSite(candidate, { ...assessment.emergency, paths: [] })) return 'hard'
  if (!matchListedSite(candidate, { ...assessment.mirror, paths: [] })) return null
  if (matchSiteListException(candidate, assessment)) return null
  return 'list'
}

export function isSiteListHostBlocked(candidate: string, assessment: SiteListAssessment): boolean {
  return classifySiteListBlock(candidate, assessment, []) !== null
}

export function isSiteListBlocked(
  candidate: string,
  assessment: SiteListAssessment,
  paths: readonly string[]
): boolean {
  return classifySiteListBlock(candidate, assessment, paths) !== null
}
