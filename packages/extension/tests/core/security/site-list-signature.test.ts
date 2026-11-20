import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519'
import {
  SITE_LIST_EXPIRED_LABEL,
  SITE_LIST_KEYS,
  assessSiteList,
  canonicalSiteListPublication,
  classifySiteListBlock,
  isSiteListBlocked,
  mergeSiteRisk,
  matchSiteListException,
  parseSiteListPublication,
  selectSiteListDocuments,
  signSiteListDocument,
  verifySiteListDocument,
  type SiteListKeyRegistry,
  type SiteListRole
} from '../../../src/core/security/site-list.ts'

const autoCurrent = ed25519.utils.randomPrivateKey()
const autoNext = ed25519.utils.randomPrivateKey()
const reviewedCurrent = ed25519.utils.randomPrivateKey()
const reviewedNext = ed25519.utils.randomPrivateKey()

const keys: SiteListKeyRegistry = {
  auto: {
    current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
    next: { id: 'auto-next', publicKey: ed25519.getPublicKey(autoNext) }
  },
  reviewed: {
    current: { id: 'reviewed-current', publicKey: ed25519.getPublicKey(reviewedCurrent) },
    next: { id: 'reviewed-next', publicKey: ed25519.getPublicKey(reviewedNext) }
  }
}

function signed(
  role: SiteListRole,
  keyId: string,
  privateKey: Uint8Array,
  expiresAt: number,
  hostnames: readonly string[] = ['evil.example'],
  version = 1
) {
  return signSiteListDocument({ role, keyId, version, expiresAt, hostnames, ips: [] }, privateKey)
}

test('keeps the higher risk and does not let a remote result lower it', () => {
  assert.equal(mergeSiteRisk('block', 'clear'), 'block')
  assert.equal(mergeSiteRisk('clear', 'block'), 'block')
  assert.equal(mergeSiteRisk('warn', 'clear'), 'warn')
  assert.equal(mergeSiteRisk('block', 'unknown'), 'block')
  assert.equal(mergeSiteRisk('warn', 'unknown'), 'warn')
  assert.equal(mergeSiteRisk('unknown', 'clear'), 'unknown')
  assert.equal(mergeSiteRisk('unknown', 'unknown'), 'unknown')
  assert.equal(mergeSiteRisk('unknown', 'warn'), 'unknown')
  assert.equal(mergeSiteRisk('clear', 'warn'), 'warn')
  assert.equal(mergeSiteRisk('warn', 'block'), 'block')
})

test('accepts only the current or next key for the document role', () => {
  const current = signed('metamask-mirror', 'auto-current', autoCurrent, 9_000)
  const next = signed('metamask-mirror', 'auto-next', autoNext, 9_000, ['next.example'])
  assert.equal(verifySiteListDocument(current, keys)?.keyId, 'auto-current')
  assert.equal(verifySiteListDocument(next, keys)?.hostnames[0], 'next.example')

  const unknown = { ...current, keyId: 'auto-retired' }
  assert.equal(verifySiteListDocument(unknown, keys), null)
  assert.equal(verifySiteListDocument(current, SITE_LIST_KEYS), null)

  const reviewedOnMirror = signed('metamask-mirror', 'reviewed-current', reviewedCurrent, 9_000)
  const autoOnEmergency = signed('emergency', 'auto-current', autoCurrent, 9_000)
  assert.equal(verifySiteListDocument(reviewedOnMirror, keys), null)
  assert.equal(verifySiteListDocument(autoOnEmergency, keys), null)
})

test('rejects a tampered, non-canonical, or path-bearing document', () => {
  const document = signed('emergency', 'reviewed-current', reviewedCurrent, 9_000)
  const tampered = { ...document, hostnames: ['other.example'] }
  assert.equal(verifySiteListDocument(tampered, keys), null)
  assert.equal(verifySiteListDocument({ ...document, expiresAt: undefined }, keys), null)

  const publication = canonicalSiteListPublication([document])
  assert.equal(publication?.includes('/'), false)
  assert.ok(parseSiteListPublication(publication ?? '', keys))
  assert.equal(parseSiteListPublication(`{"documents": []}`, keys), null)
  assert.equal(parseSiteListPublication('{"version":1,"hostnames":[],"ips":[]}', keys), null)
  assert.throws(
    () =>
      signSiteListDocument(
        {
          role: 'metamask-mirror',
          keyId: 'auto-current',
          version: 1,
          expiresAt: 9_000,
          hostnames: ['evil.example/phish'],
          ips: []
        },
        autoCurrent
      ),
    /cannot be signed/
  )
  assert.equal(
    verifySiteListDocument(
      {
        role: 'metamask-mirror',
        keyId: 'auto-current',
        version: 1,
        expiresAt: 9_000,
        hostnames: ['evil.example/phish'],
        ips: [],
        signature: 'ab'.repeat(64)
      },
      keys
    ),
    null
  )
})

test('keeps using an expired block list and drops exceptions', () => {
  const now = 5_000
  const mirror = signed('metamask-mirror', 'auto-current', autoCurrent, 1_000)
  const emergency = signed('emergency', 'reviewed-next', reviewedNext, 9_000, ['urgent.example'])
  const exception = signed('exception', 'reviewed-current', reviewedCurrent, 9_000, [
    'evil.example'
  ])
  const expired = assessSiteList([mirror, emergency, exception], now)

  assert.equal(expired.status, 'list-expired')
  assert.equal(expired.label, SITE_LIST_EXPIRED_LABEL)
  assert.equal(expired.label, 'Site list expired')
  assert.equal(isSiteListBlocked('https://evil.example/login', expired, []), true)
  assert.equal(isSiteListBlocked('https://urgent.example/', expired, []), true)
  assert.equal(matchSiteListException('https://evil.example/', expired), false)

  const current = assessSiteList(
    [
      signed('metamask-mirror', 'auto-current', autoCurrent, 9_000),
      signed('emergency', 'reviewed-current', reviewedCurrent, 9_000, ['urgent.example']),
      exception
    ],
    now
  )
  assert.equal(current.status, 'current')
  assert.equal(current.label, null)
  assert.equal(matchSiteListException('https://evil.example/path', current), true)
  assert.equal(isSiteListBlocked('https://evil.example/', current, []), false)
  assert.equal(classifySiteListBlock('https://evil.example/', current, []), null)
  assert.equal(isSiteListBlocked('https://urgent.example/', current, []), true)
  assert.equal(classifySiteListBlock('https://urgent.example/', current, []), 'hard')
  assert.equal(
    isSiteListBlocked('https://evil.example/phish', current, ['https://evil.example/phish']),
    true
  )
  assert.equal(
    classifySiteListBlock('https://evil.example/phish', current, ['https://evil.example/phish']),
    'hard'
  )

  const expiredException = assessSiteList(
    [
      signed('metamask-mirror', 'auto-current', autoCurrent, 9_000),
      signed('exception', 'reviewed-current', reviewedCurrent, 1_000, ['evil.example'])
    ],
    now
  )
  assert.equal(expiredException.status, 'current')
  assert.equal(matchSiteListException('https://evil.example/', expiredException), false)
  assert.equal(isSiteListBlocked('https://evil.example/', expiredException, []), true)
  assert.equal(classifySiteListBlock('https://evil.example/', expiredException, []), 'list')

  const exceptionOnly = assessSiteList([exception], now)
  assert.equal(exceptionOnly.status, 'unavailable')
  assert.equal(matchSiteListException('https://evil.example/', exceptionOnly), false)
})

test('does not replace a cached document with an older version', () => {
  const current = signed('metamask-mirror', 'auto-current', autoCurrent, 9_000, ['kept.example'], 2)
  const older = signed('metamask-mirror', 'auto-next', autoNext, 9_000, ['older.example'], 1)
  const selected = selectSiteListDocuments([current], [older])
  assert.equal(selected.length, 1)
  assert.deepEqual(selected[0]?.hostnames, ['kept.example'])
})
