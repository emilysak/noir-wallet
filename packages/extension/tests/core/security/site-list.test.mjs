import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519'
import { canonicalSiteListPublication, signSiteListDocument } from '../../../src/core/security/site-list.ts'
import {
  acceptsSiteInterceptContinuation,
  siteInterceptHost
} from '../../../src/background/site-list-intercept.ts'

const storage = {}
const session = {}
let responseBody = JSON.stringify({ version: 1, hostnames: [], ips: [] })
let releaseFetch = () => {}

globalThis.chrome = {
  storage: {
    local: {
      async get() {
        return storage
      },
      async set(value) {
        Object.assign(storage, value)
      }
    },
    session: {
      async get(key) {
        if (typeof key === 'string') return { [key]: session[key] }
        return { ...session }
      },
      async set(value) {
        Object.assign(session, value)
      },
      async remove(key) {
        if (typeof key === 'string') delete session[key]
      }
    }
  }
}

const requested = []

function recordRequest(url, init) {
  requested.push({
    url: String(url),
    method: init?.method ?? 'GET',
    body: init?.body ?? null
  })
}

function defaultFetch(url, init) {
  recordRequest(url, init)
  return Promise.resolve(
    new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  )
}

let fetchImplementation = defaultFetch
globalThis.fetch = (url, init) => fetchImplementation(url, init)

function hangFetch(response) {
  fetchImplementation = (url, init) =>
    new Promise(resolve => {
      recordRequest(url, init)
      releaseFetch = () => resolve(response)
    })
}

function decisionWhileLoading(check) {
  return Promise.race([
    check,
    new Promise(resolve => setTimeout(() => resolve('still-loading'), 200))
  ])
}

const { SITE_LIST_URL } = await import('../../../src/config/site-list.ts')
const {
  acknowledgeListedOrigin,
  addSiteListAppliedListener,
  forgetSiteListAcknowledgementMemoryForTests,
  hostVerdictCacheKeysForTests,
  isBlockedDAppSite,
  isCachedHardBlockedSite,
  readDAppSiteVerdict,
  refreshSiteList,
  getSiteListSnapshot,
  useSiteListKeys,
  resetSiteListStateForTests
} = await import('../../../src/background/site-list.ts')

const autoCurrent = ed25519.utils.randomPrivateKey()

test('site list cache', async t => {
  await t.test(
    'blocks a local path prefix when the published list is missing without sending the path',
    async () => {
      resetSiteListStateForTests()
      delete storage.site_list_v2
      requested.length = 0
      releaseFetch = () => {}
      fetchImplementation = defaultFetch
      responseBody = JSON.stringify({ version: 1, hostnames: [], ips: [] })
      const pageUrl = 'https://evil.example/phish/login'
      hangFetch(
        new Response(responseBody, {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      try {
        const blocked = await decisionWhileLoading(
          isBlockedDAppSite('https://evil.example', pageUrl, ['https://evil.example/phish'])
        )

        assert.equal(blocked, 'blocked')
        assert.equal(requested.length, 1)
        assert.equal(requested[0].url, SITE_LIST_URL)
        assert.equal(requested[0].method, 'GET')
        assert.equal(requested[0].body, null)
        assert.equal(requested[0].url.includes('phish'), false)
        assert.equal(requested[0].url.includes(pageUrl), false)
        assert.equal(storage.site_list_v2, undefined)
      } finally {
        releaseFetch()
        fetchImplementation = defaultFetch
        await refreshSiteList()
      }
    }
  )

  await t.test('keeps a cold start unknown until the list load finishes', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    releaseFetch = () => {}
    useSiteListKeys({
      auto: {
        current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
        next: { id: 'auto-next', publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) }
      },
      reviewed: null
    })
    const published =
      canonicalSiteListPublication([
        signSiteListDocument(
          {
            role: 'metamask-mirror',
            keyId: 'auto-current',
            version: 1,
            expiresAt: 9_000_000_000_000,
            hostnames: ['evil.example'],
            ips: []
          },
          autoCurrent
        )
      ]) ?? ''
    hangFetch(
      new Response(published, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const pageUrl = 'https://evil.example/login'
    try {
      const decision = await decisionWhileLoading(
        isBlockedDAppSite('https://evil.example', pageUrl)
      )

      assert.equal(decision, 'unknown')
      const waiting = await readDAppSiteVerdict('https://evil.example', pageUrl)
      assert.equal(waiting.decision, 'unknown')
      assert.equal(waiting.unknownReason, 'not-loaded')
      assert.equal(waiting.block, null)
      releaseFetch()
      await refreshSiteList()
      assert.equal(await isBlockedDAppSite('https://evil.example', pageUrl), 'blocked')
      assert.equal(
        await isBlockedDAppSite('https://other.example', 'https://other.example/login'),
        'clear'
      )
    } finally {
      releaseFetch()
      fetchImplementation = defaultFetch
      await refreshSiteList()
    }
  })

  await t.test('clears an ordinary miss when no site-list keys are configured', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    fetchImplementation = async () => {
      throw new Error('offline')
    }
    try {
      assert.equal(await isBlockedDAppSite('https://other.example'), 'clear')
      assert.equal((await readDAppSiteVerdict('https://other.example')).decision, 'clear')
      assert.equal((await readDAppSiteVerdict('https://other.example')).unknownReason, null)
    } finally {
      fetchImplementation = defaultFetch
    }
  })

  await t.test('stays unknown when the first list fetch fails', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    useSiteListKeys({
      auto: {
        current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
        next: { id: 'auto-next', publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) }
      },
      reviewed: null
    })
    fetchImplementation = async () => {
      throw new Error('offline')
    }
    try {
      assert.equal(await isBlockedDAppSite('https://evil.example'), 'unknown')
      assert.equal((await readDAppSiteVerdict('https://evil.example')).unknownReason, 'not-loaded')
      await refreshSiteList()
      assert.equal(await isBlockedDAppSite('https://evil.example'), 'unknown')
      assert.equal((await readDAppSiteVerdict('https://evil.example')).unknownReason, 'not-loaded')
      assert.equal(storage.site_list_v2, undefined)
    } finally {
      fetchImplementation = defaultFetch
    }
  })

  await t.test('does not treat an empty publication as a loaded list', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    fetchImplementation = defaultFetch
    useSiteListKeys({
      auto: {
        current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
        next: { id: 'auto-next', publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) }
      },
      reviewed: null
    })
    responseBody = canonicalSiteListPublication([]) ?? ''
    await refreshSiteList({ force: true })
    assert.equal((await getSiteListSnapshot()).status, 'unavailable')

    responseBody =
      canonicalSiteListPublication([
        signSiteListDocument(
          {
            role: 'metamask-mirror',
            keyId: 'auto-current',
            version: 1,
            expiresAt: 9_000_000_000_000,
            hostnames: ['evil.example'],
            ips: []
          },
          autoCurrent
        )
      ]) ?? ''
    await refreshSiteList({ force: true })
    assert.equal(await isBlockedDAppSite('https://evil.example'), 'blocked')
    assert.equal(await isBlockedDAppSite('https://other.example'), 'clear')
    await refreshSiteList()

    responseBody = canonicalSiteListPublication([]) ?? ''
    await refreshSiteList({ force: true })
    assert.equal(await isBlockedDAppSite('https://evil.example'), 'blocked')
    assert.equal(await isBlockedDAppSite('https://other.example'), 'clear')
    assert.deepEqual(storage.site_list_v2.documents[0].hostnames, ['evil.example'])
  })

  await t.test('keeps an expired verified cache when a later signature fails', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    fetchImplementation = defaultFetch
    useSiteListKeys({
      auto: {
        current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
        next: { id: 'auto-next', publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) }
      },
      reviewed: null
    })
    const expired = signSiteListDocument(
      {
        role: 'metamask-mirror',
        keyId: 'auto-current',
        version: 1,
        expiresAt: 1,
        hostnames: ['evil.example'],
        ips: []
      },
      autoCurrent
    )
    responseBody = canonicalSiteListPublication([expired]) ?? ''
    await refreshSiteList({ force: true })

    const snapshot = await getSiteListSnapshot()
    assert.equal(snapshot.status, 'list-expired')
    assert.equal(snapshot.label, 'Site list expired')
    assert.equal(await isBlockedDAppSite('https://evil.example'), 'blocked')
    assert.equal(
      (await readDAppSiteVerdict('https://other.example')).unknownReason,
      'not-loaded'
    )

    const forged = signSiteListDocument(
      {
        role: 'metamask-mirror',
        keyId: 'auto-current',
        version: 2,
        expiresAt: 9_000_000_000_000,
        hostnames: ['other.example'],
        ips: []
      },
      autoCurrent
    )
    responseBody = canonicalSiteListPublication([{ ...forged, signature: 'ab'.repeat(64) }]) ?? ''
    await refreshSiteList({ force: true })

    assert.equal(await isBlockedDAppSite('https://evil.example'), 'blocked')
    assert.equal(
      (await readDAppSiteVerdict('https://other.example')).unknownReason,
      'not-loaded'
    )
    assert.deepEqual(storage.site_list_v2.documents[0].hostnames, ['evil.example'])
    assert.equal(storage.site_list_v2.documents[0].signature, expired.signature)
    const pageUrl = 'https://evil.example/phish/login'
    assert.equal(
      requested.every(request => request.body === null && !request.url.includes(pageUrl)),
      true
    )
  })

  await t.test('keeps host verdicts on separate scheme and port keys', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    fetchImplementation = defaultFetch
    useSiteListKeys({
      auto: {
        current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
        next: { id: 'auto-next', publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) }
      },
      reviewed: null
    })
    const publish = (version, hostnames) =>
      canonicalSiteListPublication([
        signSiteListDocument(
          {
            role: 'metamask-mirror',
            keyId: 'auto-current',
            version,
            expiresAt: 9_000_000_000_000,
            hostnames,
            ips: []
          },
          autoCurrent
        )
      ]) ?? ''
    responseBody = publish(1, ['evil.example'])
    await refreshSiteList({ force: true })

    assert.equal(await isBlockedDAppSite('http://evil.example'), 'blocked')
    assert.equal(await isBlockedDAppSite('https://evil.example:8443'), 'blocked')
    assert.deepEqual([...hostVerdictCacheKeysForTests()].sort(), [
      'http://evil.example',
      'https://evil.example:8443'
    ])

    await refreshSiteList()
    responseBody = publish(2, ['other.example'])
    await refreshSiteList({ force: true })
    assert.equal(await isBlockedDAppSite('https://evil.example:8443'), 'clear')
    assert.equal(await isBlockedDAppSite('http://evil.example'), 'clear')
    assert.equal(await isBlockedDAppSite('https://other.example'), 'blocked')
    assert.deepEqual([...hostVerdictCacheKeysForTests()].sort(), [
      'http://evil.example',
      'https://evil.example:8443',
      'https://other.example'
    ])

    const paths = ['https://evil.example/phish']
    assert.equal(
      await isBlockedDAppSite('https://evil.example', 'https://evil.example/phish/login', paths),
      'blocked'
    )
    assert.equal(
      await isBlockedDAppSite('https://evil.example', 'https://evil.example/ok', paths),
      'clear'
    )
    assert.equal(hostVerdictCacheKeysForTests().includes('https://evil.example/phish'), false)
    assert.equal(hostVerdictCacheKeysForTests().includes('https://evil.example'), true)
  })

  await t.test('keeps the higher result from the page and the origin', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    fetchImplementation = async () => {
      throw new Error('offline')
    }
    useSiteListKeys({
      auto: {
        current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
        next: { id: 'auto-next', publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) }
      },
      reviewed: null
    })
    const paths = ['https://evil.example/phish']
    try {
      assert.equal(
        await isBlockedDAppSite('https://evil.example', 'https://evil.example/phish/login', paths),
        'blocked'
      )
      await refreshSiteList()

      fetchImplementation = defaultFetch
      responseBody =
        canonicalSiteListPublication([
          signSiteListDocument(
            {
              role: 'metamask-mirror',
              keyId: 'auto-current',
              version: 1,
              expiresAt: 9_000_000_000_000,
              hostnames: ['evil.example'],
              ips: []
            },
            autoCurrent
          )
        ]) ?? ''
      await refreshSiteList({ force: true })
      assert.equal(
        await isBlockedDAppSite('https://evil.example', 'https://ok.example/home'),
        'blocked'
      )
      assert.equal(await isBlockedDAppSite('https://ok.example', 'https://ok.example/home'), 'clear')
    } finally {
      fetchImplementation = defaultFetch
    }
  })

  await t.test('notifies listeners after a verified snapshot is stored', async () => {
    resetSiteListStateForTests()
    delete storage.site_list_v2
    requested.length = 0
    fetchImplementation = async () => {
      throw new Error('offline')
    }
    useSiteListKeys({
      auto: {
        current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
        next: { id: 'auto-next', publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) }
      },
      reviewed: null
    })
    const document = signSiteListDocument(
      {
        role: 'metamask-mirror',
        keyId: 'auto-current',
        version: 1,
        expiresAt: 9_000_000_000_000,
        hostnames: ['evil.example'],
        ips: []
      },
      autoCurrent
    )
    let applied = 0
    const removeListener = addSiteListAppliedListener(() => {
      applied += 1
    })
    try {
      await refreshSiteList({ force: true })
      assert.equal(applied, 0)
      assert.equal(storage.site_list_v2, undefined)

      fetchImplementation = defaultFetch
      responseBody = canonicalSiteListPublication([document]) ?? ''
      await refreshSiteList({ force: true })
      assert.equal(applied, 1)
      assert.deepEqual(storage.site_list_v2.documents[0].hostnames, ['evil.example'])

      await refreshSiteList()
      assert.equal(applied, 1)
    } finally {
      removeListener()
      fetchImplementation = defaultFetch
    }
  })

  await t.test(
    'keeps hard blocks closed and treats a confirmed mirror hit as unknown',
    async () => {
      resetSiteListStateForTests()
      delete storage.site_list_v2
      for (const key of Object.keys(session)) delete session[key]
      requested.length = 0
      fetchImplementation = defaultFetch
      const reviewed = ed25519.utils.randomPrivateKey()
      useSiteListKeys({
        auto: {
          current: { id: 'auto-current', publicKey: ed25519.getPublicKey(autoCurrent) },
          next: {
            id: 'auto-next',
            publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
          }
        },
        reviewed: {
          current: { id: 'reviewed-current', publicKey: ed25519.getPublicKey(reviewed) },
          next: {
            id: 'reviewed-next',
            publicKey: ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
          }
        }
      })
      responseBody =
        canonicalSiteListPublication([
          signSiteListDocument(
            {
              role: 'metamask-mirror',
              keyId: 'auto-current',
              version: 1,
              expiresAt: 9_000_000_000_000,
              hostnames: ['evil.example'],
              ips: []
            },
            autoCurrent
          ),
          signSiteListDocument(
            {
              role: 'emergency',
              keyId: 'reviewed-current',
              version: 1,
              expiresAt: 9_000_000_000_000,
              hostnames: ['urgent.example'],
              ips: []
            },
            reviewed
          )
        ]) ?? ''
      await refreshSiteList({ force: true })

      const listed = await readDAppSiteVerdict('https://evil.example')
      assert.equal(listed.decision, 'blocked')
      assert.equal(listed.block, 'list')
      assert.equal(listed.unknownReason, null)
      assert.equal(listed.originKey, 'https://evil.example')
      assert.equal(await isCachedHardBlockedSite('https://evil.example'), false)

      const emergency = await readDAppSiteVerdict('https://urgent.example')
      assert.equal(emergency.block, 'hard')
      assert.equal(await isCachedHardBlockedSite('https://urgent.example'), true)

      const paths = ['https://evil.example/phish']
      const pathHit = await readDAppSiteVerdict(
        'https://evil.example',
        'https://evil.example/phish/login',
        paths
      )
      assert.equal(pathHit.block, 'hard')
      assert.equal(
        await isCachedHardBlockedSite('https://evil.example/phish/login', paths),
        true
      )

      assert.equal(await acknowledgeListedOrigin('https://evil.example/login?token=secret'), true)
      const stored = await chrome.storage.session.get(null)
      const storedText = JSON.stringify(stored)
      assert.equal(storedText.includes('https://evil.example'), true)
      assert.equal(storedText.includes('/login'), false)
      assert.equal(storedText.includes('token'), false)

      forgetSiteListAcknowledgementMemoryForTests()
      const confirmed = await readDAppSiteVerdict('https://evil.example', 'https://evil.example/ok')
      assert.equal(confirmed.decision, 'unknown')
      assert.equal(confirmed.unknownReason, 'acknowledged')
      assert.notEqual(confirmed.decision, 'clear')
      assert.notEqual(confirmed.unknownReason, 'not-loaded')
      assert.equal(await isCachedHardBlockedSite('https://evil.example'), false)

      const stillHard = await readDAppSiteVerdict('https://urgent.example')
      assert.equal(stillHard.decision, 'blocked')
      assert.equal(stillHard.block, 'hard')
      assert.equal(stillHard.unknownReason, null)
      const pathStillHard = await readDAppSiteVerdict(
        'https://evil.example',
        'https://evil.example/phish/login',
        paths
      )
      assert.equal(pathStillHard.block, 'hard')
      assert.equal(pathStillHard.decision, 'blocked')

      assert.equal(siteInterceptHost('https://evil.example'), 'evil.example')
      assert.equal(siteInterceptHost('https://evil.example:8443'), 'evil.example:8443')
      assert.equal(siteInterceptHost('https://evil.example/phish'), null)
      assert.equal(acceptsSiteInterceptContinuation('hard', 'evil.example', 'evil.example'), false)
      assert.equal(acceptsSiteInterceptContinuation('list', 'evil.example', 'evil.example'), true)
      assert.equal(
        acceptsSiteInterceptContinuation('list', 'evil.example:8443', 'evil.example'),
        false
      )
      assert.equal(acceptsSiteInterceptContinuation('list', 'evil.example', ' evil.example'), false)
    }
  )
})
