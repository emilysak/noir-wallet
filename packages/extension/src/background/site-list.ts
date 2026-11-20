import { DedupPromise } from '@/lib/async-utils'
import {
  SITE_LIST_KEYS,
  assessSiteList,
  siteListKeysProvisioned,
  classifySiteListBlock,
  higherSiteRisk,
  matchListedSite,
  mergeSiteRisk,
  originCacheKey,
  parseSiteListPublication,
  selectSiteListDocuments,
  verifySiteListDocument,
  type SignedSiteListDocument,
  type SiteListAssessment,
  type SiteListBlockKind,
  type SiteListKeyRegistry,
  type SiteRisk
} from '@/core/security/site-list'
import { SITE_LIST_PATHS } from '@/core/security/site-list-paths'
import {
  SITE_LIST_CACHE_TTL_MS,
  SITE_LIST_FETCH_TIMEOUT_MS,
  SITE_LIST_URL
} from '@/config/site-list'

const STORAGE_KEY = 'site_list_v2'
const ACK_STORAGE_KEY = 'site_list_acknowledgements_v1'

interface CachedSiteList {
  readonly fetchedAt: number
  readonly documents: readonly SignedSiteListDocument[]
}

export interface SiteListSnapshot extends SiteListAssessment {
  readonly fetchedAt: number | null
}

let verificationKeys: SiteListKeyRegistry = SITE_LIST_KEYS
let cachedSiteList: CachedSiteList | null = null
let cacheHydrated = false
let lastFailedAt = 0
let siteListRevision = 0
let hostVerdictRevision = -1
const hostVerdicts = new Map<string, SiteListBlockKind | 'none'>()
const acknowledgedOrigins = new Set<string>()
let acknowledgementsHydrated = false
let acknowledgementReset: Promise<void> = Promise.resolve()
const cacheRead = new DedupPromise<void>()
const acknowledgementRead = new DedupPromise<void>()
const remoteRead = new DedupPromise<boolean>()
const appliedListeners = new Set<() => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function useSiteListKeys(keys: SiteListKeyRegistry): void {
  verificationKeys = keys
}

export function resetSiteListStateForTests(): void {
  verificationKeys = SITE_LIST_KEYS
  cachedSiteList = null
  cacheHydrated = false
  lastFailedAt = 0
  siteListRevision = 0
  hostVerdictRevision = -1
  hostVerdicts.clear()
  appliedListeners.clear()
  acknowledgedOrigins.clear()
  acknowledgementsHydrated = false
  const session = chrome.storage?.session
  acknowledgementReset = session
    ? Promise.resolve()
        .then(() => session.remove(ACK_STORAGE_KEY))
        .then(() => {
          acknowledgedOrigins.clear()
          acknowledgementsHydrated = false
        })
        .catch(() => undefined)
    : Promise.resolve()
}

/** Drops the in-memory acknowledgement set so the next read reloads session storage. */
export function forgetSiteListAcknowledgementMemoryForTests(): void {
  acknowledgedOrigins.clear()
  acknowledgementsHydrated = false
}

export function hostVerdictCacheKeysForTests(): readonly string[] {
  return [...hostVerdicts.keys()]
}

function rememberSiteList(next: CachedSiteList): void {
  cachedSiteList = next
  siteListRevision += 1
}

/** Fires after a verified snapshot is stored. Listeners must not wait on another refresh. */
export function addSiteListAppliedListener(listener: () => void): () => void {
  appliedListeners.add(listener)
  return () => {
    appliedListeners.delete(listener)
  }
}

function notifySiteListApplied(): void {
  for (const listener of appliedListeners) {
    try {
      listener()
    } catch {
      // Revocation work cannot invalidate a snapshot that was already accepted.
    }
  }
}

function readStoredSiteList(value: unknown): CachedSiteList | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.fetchedAt) ||
    !Array.isArray(value.documents)
  ) {
    return null
  }
  const fetchedAt = value.fetchedAt as number
  if (fetchedAt <= 0 || fetchedAt > Date.now()) return null
  const documents: SignedSiteListDocument[] = []
  const roles = new Set<string>()
  for (const entry of value.documents) {
    const document = verifySiteListDocument(entry, verificationKeys)
    if (!document || roles.has(document.role)) return null
    roles.add(document.role)
    documents.push(document)
  }
  return { fetchedAt, documents }
}

async function persistSiteList(cached: CachedSiteList): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        fetchedAt: cached.fetchedAt,
        documents: cached.documents
      }
    })
  } catch {
    // The memory cache still applies when persistent storage is unavailable.
  }
}

async function hydrateSiteList(): Promise<void> {
  if (cacheHydrated) return
  await cacheRead.run(async () => {
    if (cacheHydrated) return
    try {
      const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
      const parsed = readStoredSiteList(stored)
      if (parsed && (!cachedSiteList || cachedSiteList.fetchedAt < parsed.fetchedAt)) {
        rememberSiteList(parsed)
      }
    } catch {
      // Storage failure leaves hostname and IP matching on the last memory cache.
    } finally {
      cacheHydrated = true
    }
  })
}

export function refreshSiteList(options?: { readonly force?: boolean }): Promise<void> {
  const force = options?.force === true
  const pending = remoteRead.run(async () => {
    await hydrateSiteList()
    const now = Date.now()
    if (!force && cachedSiteList && now - cachedSiteList.fetchedAt < SITE_LIST_CACHE_TTL_MS) {
      return false
    }
    if (!force && lastFailedAt && now - lastFailedAt < SITE_LIST_CACHE_TTL_MS) return false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SITE_LIST_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(SITE_LIST_URL, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw new Error('Site list is temporarily unavailable')
      const published = parseSiteListPublication(await response.text(), verificationKeys)
      if (!published) throw new Error('Site list is temporarily unavailable')
      const fetchedAt = Date.now()
      // An empty publication does not clear a list that is already current.
      const next = {
        fetchedAt,
        documents:
          published.length === 0
            ? (cachedSiteList?.documents ?? [])
            : selectSiteListDocuments(cachedSiteList?.documents ?? [], published)
      }
      rememberSiteList(next)
      lastFailedAt = 0
      await persistSiteList(next)
      return true
    } catch {
      lastFailedAt = Date.now()
      return false
    } finally {
      clearTimeout(timer)
    }
  })
  return pending
    .then(applied => {
      if (applied) notifySiteListApplied()
    })
    .catch(() => undefined)
}

export type SiteListDecision = 'blocked' | 'clear' | 'unknown'
export type SiteListUnknownReason = 'not-loaded' | 'acknowledged'

export interface SiteListVerdict {
  readonly decision: SiteListDecision
  readonly block: SiteListBlockKind | null
  readonly unknownReason: SiteListUnknownReason | null
  /** Canonical origin for a list hit. Path, query, and fragment are omitted. */
  readonly originKey: string | null
}

const CLEAR_VERDICT: SiteListVerdict = {
  decision: 'clear',
  block: null,
  unknownReason: null,
  originKey: null
}

const NOT_LOADED_VERDICT: SiteListVerdict = {
  decision: 'unknown',
  block: null,
  unknownReason: 'not-loaded',
  originKey: null
}

function snapshot(now: number): SiteListSnapshot {
  return {
    fetchedAt: cachedSiteList?.fetchedAt ?? null,
    ...assessSiteList(cachedSiteList?.documents ?? [], now)
  }
}

export async function getSiteListSnapshot(now = Date.now()): Promise<SiteListSnapshot> {
  await hydrateSiteList()
  return snapshot(now)
}

async function hydrateAcknowledgements(): Promise<void> {
  await acknowledgementReset
  if (acknowledgementsHydrated) return
  await acknowledgementRead.run(async () => {
    await acknowledgementReset
    if (acknowledgementsHydrated) return
    try {
      const session = chrome.storage?.session
      if (!session) return
      const stored = (await session.get(ACK_STORAGE_KEY))[ACK_STORAGE_KEY]
      if (!Array.isArray(stored)) return
      for (const entry of stored) {
        if (typeof entry === 'string' && originCacheKey(entry) === entry) {
          acknowledgedOrigins.add(entry)
        }
      }
    } catch {
      // Missing session storage leaves acknowledgements empty.
    } finally {
      acknowledgementsHydrated = true
    }
  })
}

/** Remembers a canonical origin for this browser session. A page path is not stored. */
export async function acknowledgeListedOrigin(origin: string): Promise<boolean> {
  const key = originCacheKey(origin)
  if (!key) return false
  await hydrateAcknowledgements()
  acknowledgedOrigins.add(key)
  try {
    const session = chrome.storage?.session
    if (session) await session.set({ [ACK_STORAGE_KEY]: [...acknowledgedOrigins] })
  } catch {
    // The in-memory set still applies until this worker stops.
  }
  return true
}

function hostBlockKind(candidate: string, assessment: SiteListSnapshot): SiteListBlockKind | null {
  if (hostVerdictRevision !== siteListRevision) {
    hostVerdicts.clear()
    hostVerdictRevision = siteListRevision
  }
  const read = () => classifySiteListBlock(candidate, assessment, [])
  const key = originCacheKey(candidate)
  if (key === null) return read()
  const cached = hostVerdicts.get(key)
  if (cached !== undefined) return cached === 'none' ? null : cached
  const kind = read()
  hostVerdicts.set(key, kind ?? 'none')
  return kind
}

function toSiteDecision(risk: SiteRisk): SiteListDecision {
  if (risk === 'block') return 'blocked'
  // A warning does not reject the request.
  if (risk === 'unknown') return 'unknown'
  return 'clear'
}

function decideCandidate(
  candidate: string,
  paths: readonly string[],
  now: number
): SiteListVerdict {
  const current = snapshot(now)
  // No configured public keys means there is no remote list to load.
  // A configured list that is missing, empty, invalid, or expired stays not-loaded.
  const listLoaded = !siteListKeysProvisioned(verificationKeys) || current.status === 'current'
  const originKey = originCacheKey(candidate)
  const pathHard = matchListedSite(candidate, { hostnames: [], ips: [], paths })
  const hostKind = hostBlockKind(candidate, current)
  const local: SiteRisk = pathHard ? 'block' : listLoaded ? 'clear' : 'unknown'
  // A current miss is clear and cannot lower a local path block.
  const remote: SiteRisk = hostKind !== null ? 'block' : listLoaded ? 'clear' : 'unknown'
  const decision = toSiteDecision(mergeSiteRisk(local, remote))
  if (decision !== 'blocked') {
    return decision === 'unknown' ? NOT_LOADED_VERDICT : CLEAR_VERDICT
  }
  const block: SiteListBlockKind = pathHard || hostKind === 'hard' ? 'hard' : 'list'
  // A confirmed mirror hit stays unknown. It is not a miss, and it does not cover a hard block.
  if (block === 'list' && originKey !== null && acknowledgedOrigins.has(originKey)) {
    return { decision: 'unknown', block: null, unknownReason: 'acknowledged', originKey }
  }
  return { decision: 'blocked', block, unknownReason: null, originKey }
}

function verdictRisk(verdict: SiteListVerdict): SiteRisk {
  if (verdict.decision === 'blocked') return 'block'
  if (verdict.decision === 'unknown') return 'unknown'
  return 'clear'
}

function preferVerdict(left: SiteListVerdict, right: SiteListVerdict): SiteListVerdict {
  const risk = higherSiteRisk(verdictRisk(left), verdictRisk(right))
  if (risk === 'block') {
    if (left.block === 'hard') return left
    if (right.block === 'hard') return right
    if (left.block === 'list') return left
    if (right.block === 'list') return right
  }
  if (risk === 'unknown') {
    if (left.unknownReason === 'not-loaded' || right.unknownReason === 'not-loaded') {
      return NOT_LOADED_VERDICT
    }
    if (left.unknownReason === 'acknowledged') return left
    if (right.unknownReason === 'acknowledged') return right
    return NOT_LOADED_VERDICT
  }
  return CLEAR_VERDICT
}

function decideDAppSite(
  origin: string,
  pageUrl: string | undefined,
  paths: readonly string[]
): SiteListVerdict {
  const now = Date.now()
  const originVerdict = decideCandidate(origin, paths, now)
  if (pageUrl === undefined || pageUrl.length === 0) return originVerdict
  return preferVerdict(decideCandidate(pageUrl, paths, now), originVerdict)
}

async function loadDAppSiteVerdict(
  origin: string,
  pageUrl: string | undefined,
  paths: readonly string[]
): Promise<SiteListVerdict> {
  await hydrateSiteList()
  await hydrateAcknowledgements()
  const verdict = decideDAppSite(origin, pageUrl, paths)
  // A cold start stays unknown until the caller awaits this load and checks again.
  void refreshSiteList()
  return verdict
}

export async function readDAppSiteVerdict(
  origin: string,
  pageUrl?: string,
  paths: readonly string[] = SITE_LIST_PATHS
): Promise<SiteListVerdict> {
  return loadDAppSiteVerdict(origin, pageUrl, paths)
}

export async function isBlockedDAppSite(
  origin: string,
  pageUrl?: string,
  paths: readonly string[] = SITE_LIST_PATHS
): Promise<SiteListDecision> {
  return (await loadDAppSiteVerdict(origin, pageUrl, paths)).decision
}

/** Reads the hydrated cache only. Saved-connection scans revoke hard blocks, not mirror hits. */
export async function isCachedHardBlockedSite(
  candidate: string,
  paths: readonly string[] = SITE_LIST_PATHS
): Promise<boolean> {
  await hydrateSiteList()
  return decideCandidate(candidate, paths, Date.now()).block === 'hard'
}
