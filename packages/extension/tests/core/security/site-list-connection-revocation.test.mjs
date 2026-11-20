import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessSiteList, classifySiteListBlock, isSiteListBlocked } from '../../../src/core/security/site-list.ts'
import {
  blockedSiteDisconnectedMessage,
  resetListedSiteRevocationForTests,
  revokeListedSiteConnections
} from '../../../src/background/site-list-connection-revocation.ts'

function connection(origin, host) {
  return { origin, host }
}

test('listed site connection revocation', async t => {
  await t.test('revokes and notifies a connected origin that is listed', async () => {
    resetListedSiteRevocationForTests()
    const revoked = []
    const notified = []
    const result = await revokeListedSiteConnections({
      listConnections: async () => [connection('https://evil.example', 'evil.example')],
      isBlocked: async () => true,
      revoke: async origin => {
        revoked.push(origin)
        return true
      },
      notify: host => notified.push(blockedSiteDisconnectedMessage(host))
    })

    assert.deepEqual(result, ['https://evil.example'])
    assert.deepEqual(revoked, ['https://evil.example'])
    assert.deepEqual(notified, [
      'Noir Wallet disconnected evil.example because it is on the blocked site list.'
    ])
  })

  await t.test('does not notify when the origin is not connected', async () => {
    resetListedSiteRevocationForTests()
    const notified = []
    const missing = await revokeListedSiteConnections({
      listConnections: async () => [],
      isBlocked: async () => true,
      revoke: async () => {
        throw new Error('revoke should not run')
      },
      notify: host => notified.push(host)
    })
    const disappeared = await revokeListedSiteConnections({
      listConnections: async () => [connection('https://evil.example', 'evil.example')],
      isBlocked: async () => true,
      revoke: async () => false,
      notify: host => notified.push(host)
    })

    assert.deepEqual(missing, [])
    assert.deepEqual(disappeared, [])
    assert.deepEqual(notified, [])
  })

  await t.test('leaves an excepted origin connected', async () => {
    resetListedSiteRevocationForTests()
    const now = Date.now()
    const assessment = assessSiteList(
      [
        {
          role: 'metamask-mirror',
          keyId: 'auto-current',
          version: 1,
          expiresAt: now + 60_000,
          hostnames: ['allowed.example', 'evil.example'],
          ips: [],
          signature: 'aa'
        },
        {
          role: 'exception',
          keyId: 'reviewed-current',
          version: 1,
          expiresAt: now + 60_000,
          hostnames: ['allowed.example'],
          ips: [],
          signature: 'bb'
        }
      ],
      now
    )
    const revoked = []
    const notified = []
    const result = await revokeListedSiteConnections({
      listConnections: async () => [
        connection('https://evil.example', 'evil.example'),
        connection('https://allowed.example', 'allowed.example')
      ],
      isBlocked: async origin => isSiteListBlocked(origin, assessment, []),
      revoke: async origin => {
        revoked.push(origin)
        return true
      },
      notify: host => notified.push(host)
    })

    assert.deepEqual(result, ['https://evil.example'])
    assert.deepEqual(revoked, ['https://evil.example'])
    assert.deepEqual(notified, ['evil.example'])
  })

  await t.test('notifies once when the same origin is revoked concurrently', async () => {
    resetListedSiteRevocationForTests()
    let release = () => {}
    const gate = new Promise(resolve => {
      release = resolve
    })
    let calls = 0
    const notified = []
    const deps = {
      listConnections: async () => [connection('https://evil.example', 'evil.example')],
      isBlocked: async () => true,
      revoke: async () => {
        calls += 1
        await gate
        return true
      },
      notify: host => notified.push(host)
    }

    const pending = Promise.all([
      revokeListedSiteConnections(deps),
      revokeListedSiteConnections(deps)
    ])
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    const [first, second] = await pending

    assert.equal(calls, 1)
    assert.deepEqual(notified, ['evil.example'])
    assert.deepEqual([...first, ...second], ['https://evil.example'])
  })

  await t.test('revokes the origin when only the active page path is listed', async () => {
    resetListedSiteRevocationForTests()
    const assessment = {
      status: 'unavailable',
      label: null,
      mirror: { hostnames: [], ips: [] },
      emergency: { hostnames: [], ips: [] },
      exceptions: { hostnames: [], ips: [] }
    }
    const origin = 'https://evil.example'
    const pageUrl = 'https://evil.example/phish/login'
    const paths = ['https://evil.example/phish']
    assert.equal(isSiteListBlocked(origin, assessment, paths), false)
    assert.equal(isSiteListBlocked(pageUrl, assessment, paths), true)

    const revoked = []
    const notified = []
    const result = await revokeListedSiteConnections({
      listConnections: async () => [connection(origin, 'evil.example')],
      isBlocked: async () => isSiteListBlocked(pageUrl, assessment, paths),
      revoke: async target => {
        revoked.push(target)
        return true
      },
      notify: host => notified.push(host)
    })

    assert.deepEqual(result, [origin])
    assert.deepEqual(revoked, [origin])
    assert.deepEqual(notified, ['evil.example'])
  })

  await t.test('revokes hard hits and leaves a mirror-only origin connected', async () => {
    resetListedSiteRevocationForTests()
    const now = Date.now()
    const assessment = assessSiteList(
      [
        {
          role: 'metamask-mirror',
          keyId: 'auto-current',
          version: 1,
          expiresAt: now + 60_000,
          hostnames: ['listed.example'],
          ips: [],
          signature: 'aa'
        },
        {
          role: 'emergency',
          keyId: 'reviewed-current',
          version: 1,
          expiresAt: now + 60_000,
          hostnames: ['urgent.example'],
          ips: [],
          signature: 'bb'
        }
      ],
      now
    )
    const paths = ['https://evil.example/phish']
    assert.equal(classifySiteListBlock('https://listed.example', assessment, paths), 'list')
    assert.equal(classifySiteListBlock('https://urgent.example', assessment, paths), 'hard')
    assert.equal(
      classifySiteListBlock('https://evil.example/phish/login', assessment, paths),
      'hard'
    )

    const revoked = []
    const result = await revokeListedSiteConnections({
      listConnections: async () => [
        connection('https://listed.example', 'listed.example'),
        connection('https://urgent.example', 'urgent.example'),
        connection('https://evil.example', 'evil.example')
      ],
      isBlocked: async target => classifySiteListBlock(target, assessment, paths) === 'hard',
      revoke: async target => {
        revoked.push(target)
        return true
      },
      notify: () => {}
    })

    assert.deepEqual(result, ['https://urgent.example'])
    assert.deepEqual(revoked, ['https://urgent.example'])
  })
})
