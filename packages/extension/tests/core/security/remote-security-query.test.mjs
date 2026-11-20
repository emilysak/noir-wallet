import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PEA_REMOTE_SECURITY_QUERY_CONSENT,
  REMOTE_SECURITY_QUERY_DELAY_MAX_MS,
  REMOTE_SECURITY_QUERY_DELAY_MIN_MS,
  grantRemoteSecurityQuery,
  remoteSecurityQueryDelayMs,
  remoteSecurityQueryJudgment,
  runRemoteSecurityQuery
} from '../../../src/core/security/remote-security-query.ts'

function query(overrides = {}) {
  return {
    accountId: 'account-alpha',
    executionMode: 'private',
    url: 'https://security.example/check',
    ...overrides
  }
}

function transport() {
  const calls = []
  const delays = []
  return {
    calls,
    delays,
    dependencies: {
      fetch: (url, init) => {
        calls.push({ url: String(url), init })
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
      randomDelayMs: () => REMOTE_SECURITY_QUERY_DELAY_MIN_MS,
      delay: ms => {
        delays.push(ms)
        return Promise.resolve()
      }
    }
  }
}

async function settle() {
  for (let step = 0; step < 8; step += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('private mode does not send a remote security query without consent', async () => {
  const gate = transport()
  const result = await runRemoteSecurityQuery(query(), null, gate.dependencies)

  assert.deepEqual(result, { status: 'skipped', reason: 'consent-required' })
  assert.equal(remoteSecurityQueryJudgment(result), 'unknown')
  assert.equal(gate.calls.length, 0)
  assert.equal(gate.delays.length, 0)
})

test('a consent for another account, URL, method, or body is not reused', async () => {
  const granted = await grantRemoteSecurityQuery(
    query({ method: 'POST', body: '{"token":"one"}', url: 'https://bind.example/check' })
  )
  const cases = [
    query({
      accountId: 'account-beta',
      method: 'POST',
      body: '{"token":"one"}',
      url: 'https://bind.example/check'
    }),
    query({ method: 'POST', body: '{"token":"one"}', url: 'https://bind.example/other' }),
    query({ method: 'POST', body: '{"token":"two"}', url: 'https://bind.example/check' }),
    query({ url: 'https://bind.example/check' })
  ]

  for (const candidate of cases) {
    const gate = transport()
    const result = await runRemoteSecurityQuery(candidate, granted, gate.dependencies)
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'consent-mismatch')
    assert.equal(remoteSecurityQueryJudgment(result), 'unknown')
    assert.equal(gate.calls.length, 0)
  }
})

test('a matching private consent sends once and cannot be spent again', async () => {
  const request = query({
    url: 'https://once.example/check',
    headers: {
      accept: 'application/json',
      cookie: 'session=1',
      'x-account-id': 'not-this-account'
    }
  })
  const consent = await grantRemoteSecurityQuery(request)
  const gate = transport()
  const sent = await runRemoteSecurityQuery(request, consent, gate.dependencies)
  const repeated = await runRemoteSecurityQuery(request, consent, gate.dependencies)

  assert.equal(sent.status, 'completed')
  assert.equal(remoteSecurityQueryJudgment(sent), null)
  assert.equal(repeated.status, 'skipped')
  assert.equal(repeated.reason, 'consent-spent')
  assert.equal(gate.calls.length, 1)
  assert.deepEqual(gate.delays, [REMOTE_SECURITY_QUERY_DELAY_MIN_MS])

  const init = gate.calls[0].init
  const headers = new Headers(init.headers)
  assert.equal(init.credentials, 'omit')
  assert.equal(init.cache, 'no-store')
  assert.equal(init.keepalive, false)
  assert.equal(init.redirect, 'error')
  assert.equal(init.referrerPolicy, 'no-referrer')
  assert.equal(headers.get('accept'), 'application/json')
  assert.equal(headers.has('cookie'), false)
  assert.equal(headers.has('x-account-id'), false)
  assert.equal(gate.calls[0].url.includes('account-alpha'), false)
})

test('main mode sends without a private consent', async () => {
  const gate = transport()
  const result = await runRemoteSecurityQuery(
    query({ executionMode: 'main', url: 'https://main.example/check' }),
    null,
    gate.dependencies
  )

  assert.equal(result.status, 'completed')
  assert.equal(gate.calls.length, 1)
  assert.deepEqual(gate.delays, [REMOTE_SECURITY_QUERY_DELAY_MIN_MS])
})

test('a main-mode allowance does not authorize private mode', async () => {
  const request = query({ executionMode: 'main', url: 'https://mode.example/check' })
  const consent = await grantRemoteSecurityQuery(request)
  const gate = transport()
  const result = await runRemoteSecurityQuery(
    { ...request, executionMode: 'private' },
    consent,
    gate.dependencies
  )

  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'consent-mismatch')
  assert.equal(gate.calls.length, 0)
})

test('different accounts do not share an in-flight request', async () => {
  const delays = []
  const calls = []
  let active = 0
  let maxActive = 0
  const releases = []
  const dependencies = {
    fetch: (url, init) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      calls.push({ url: String(url), init })
      return new Promise(resolve => {
        releases.push(() => {
          active -= 1
          resolve(new Response('{}', { status: 200 }))
        })
      })
    },
    randomDelayMs: () => 450,
    delay: ms => {
      delays.push(ms)
      return Promise.resolve()
    }
  }
  const firstQuery = query({
    accountId: 'account-alpha',
    url: 'https://lane.example/alpha',
    headers: { cookie: 'a=1', accept: 'application/json' }
  })
  const secondQuery = query({
    accountId: 'account-beta',
    url: 'https://lane.example/beta',
    headers: { cookie: 'b=1', accept: 'application/json' }
  })
  const firstConsent = await grantRemoteSecurityQuery(firstQuery)
  const secondConsent = await grantRemoteSecurityQuery(secondQuery)
  const first = runRemoteSecurityQuery(firstQuery, firstConsent, dependencies)
  const second = runRemoteSecurityQuery(secondQuery, secondConsent, dependencies)
  await settle()

  assert.equal(calls.length, 1)
  assert.equal(delays.length, 1)
  assert.equal(maxActive, 1)
  releases[0]()
  await first
  await settle()

  assert.equal(calls.length, 2)
  assert.equal(delays.length, 2)
  assert.equal(maxActive, 1)
  assert.notEqual(calls[0].init, calls[1].init)
  for (const call of calls) {
    const headers = new Headers(call.init.headers)
    assert.equal(headers.has('cookie'), false)
    assert.equal(call.url.includes('account-alpha'), false)
    assert.equal(call.url.includes('account-beta'), false)
    assert.equal([...headers.values()].join('\n').includes('account-alpha'), false)
    assert.equal([...headers.values()].join('\n').includes('account-beta'), false)
  }
  releases[1]()
  const secondResult = await second
  assert.equal(secondResult.status, 'completed')
  assert.equal(maxActive, 1)
})

test('the account id is not placed on a security query', async () => {
  const accountId = 'account-alpha'
  const gate = transport()
  await assert.rejects(
    runRemoteSecurityQuery(
      query({ url: `https://leak.example/check?id=${accountId}` }),
      null,
      gate.dependencies
    ),
    /cannot include the account/
  )
  const consent = await grantRemoteSecurityQuery(query({ url: 'https://leak.example/check' }))
  await assert.rejects(
    runRemoteSecurityQuery(
      query({
        url: 'https://leak.example/check',
        headers: { accept: accountId }
      }),
      consent,
      gate.dependencies
    ),
    /cannot include the account/
  )
  assert.equal(gate.calls.length, 0)
})

test('private consent copy stays a one-time allowance', () => {
  assert.deepEqual(PEA_REMOTE_SECURITY_QUERY_CONSENT, {
    title: 'Check this with the security service?',
    message:
      'Private execution mode does not send this address, token, or site unless you allow this check. The allowance covers this check only.',
    confirmText: 'Allow this check',
    cancelText: 'Skip check'
  })
})

test('security query jitter stays inside its window', () => {
  const span = REMOTE_SECURITY_QUERY_DELAY_MAX_MS - REMOTE_SECURITY_QUERY_DELAY_MIN_MS + 1
  assert.equal(
    remoteSecurityQueryDelayMs(() => 0),
    REMOTE_SECURITY_QUERY_DELAY_MIN_MS
  )
  assert.equal(
    remoteSecurityQueryDelayMs(() => span - 1),
    REMOTE_SECURITY_QUERY_DELAY_MAX_MS
  )
  assert.equal(
    remoteSecurityQueryDelayMs(() => span),
    REMOTE_SECURITY_QUERY_DELAY_MIN_MS
  )
})
