import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalContextMatches } from '../../../src/background/approval-context-policy.ts'
import {
  assertReviewedDAppSigningIdentity,
  parseZcashSignMessageApproval,
  resolveDAppMessageSigningMode,
  signApprovedDAppMessage
} from '../../../src/background/dapp-message-signing.ts'

function approval(overrides = {}) {
  return {
    action: 'sendTransaction',
    requestNetwork: 'mainnet',
    currentNetwork: 'mainnet',
    requestWalletId: 'wallet-1',
    requestAccountId: 'account-1',
    boundWalletId: 'wallet-1',
    boundAccountId: 'account-1',
    accountExists: true,
    locked: false,
    authorizationRevision: 4,
    currentAuthorizationRevision: 4,
    accountAuthorized: true,
    requestStillPending: true,
    ...overrides
  }
}

test('approval context expires on account, network, authorization, lock or request changes', () => {
  assert.equal(approvalContextMatches(approval()), true)
  for (const changed of [
    { boundWalletId: 'wallet-2' },
    { boundAccountId: 'account-2' },
    { currentNetwork: 'testnet' },
    { accountExists: false },
    { locked: true },
    { currentAuthorizationRevision: 5 },
    { accountAuthorized: false },
    { requestStillPending: false }
  ]) {
    assert.equal(approvalContextMatches(approval(changed)), false)
  }
  assert.equal(
    approvalContextMatches(approval({ action: 'connect', accountAuthorized: false })),
    true
  )
  assert.equal(
    approvalContextMatches(
      approval({
        action: 'connect',
        requestWalletId: '',
        requestAccountId: '',
        accountExists: false,
        boundWalletId: null,
        boundAccountId: null,
        accountAuthorized: false
      })
    ),
    true
  )
  assert.equal(
    approvalContextMatches(
      approval({ action: 'connect', accountAuthorized: false, currentAuthorizationRevision: 5 })
    ),
    false
  )
})

test('all message signing modes bind their primary signature to the reviewed HD account', async () => {
  const calls = []
  const core = {
    async signMessage(message, accountIndex, addressIndex) {
      calls.push({ message, accountIndex, addressIndex })
      return { signature: `signature-${accountIndex}`, address: `address-${accountIndex}` }
    }
  }

  const current = await signApprovedDAppMessage(core, 'reviewed', 3, 'current', 99)
  assert.equal(current.signingMode, 'current')
  assert.deepEqual(calls.splice(0), [
    { message: 'reviewed', accountIndex: 3, addressIndex: undefined }
  ])

  const legacy = await signApprovedDAppMessage(core, 'reviewed', 3, 'legacy_index0', 99)
  assert.equal(legacy.signingMode, 'legacy_index0')
  assert.deepEqual(calls.splice(0), [{ message: 'reviewed', accountIndex: 3, addressIndex: 0 }])

  const derived = await signApprovedDAppMessage(core, 'reviewed', 3, 'derived', 99)
  assert.equal(derived.signingMode, 'derived')
  assert.equal(derived.originAddress, 'address-3')
  assert.deepEqual(calls, [
    { message: 'reviewed', accountIndex: 99, addressIndex: undefined },
    { message: 'reviewed', accountIndex: 3, addressIndex: undefined }
  ])
})

test('unofficial origins cannot select a message signing mode', () => {
  const official = 'https://app.zknoir.com'
  const unofficial = 'https://example.com'
  assert.equal(resolveDAppMessageSigningMode(unofficial, undefined), 'current')
  assert.equal(resolveDAppMessageSigningMode(unofficial, {}), 'current')
  assert.equal(resolveDAppMessageSigningMode(unofficial, { signingMode: 'current' }), 'current')
  assert.throws(
    () => resolveDAppMessageSigningMode(unofficial, { signingMode: 'derived' }),
    /cannot request a signing mode/
  )
  assert.throws(
    () => resolveDAppMessageSigningMode(unofficial, { signingMode: 'legacy_index0' }),
    /cannot request a signing mode/
  )
  assert.equal(resolveDAppMessageSigningMode(official, { signingMode: 'derived' }), 'derived')
  assert.equal(
    resolveDAppMessageSigningMode(official, { signingMode: 'legacy_index0' }),
    'legacy_index0'
  )
  assert.throws(
    () => resolveDAppMessageSigningMode(official, { signingMode: 'custom' }),
    /signingMode/
  )
  assert.throws(() => resolveDAppMessageSigningMode(unofficial, 'derived'), /signing options/)
})

test('message approval requires the reviewed signing identity', () => {
  assert.deepEqual(
    parseZcashSignMessageApproval({
      message: 'Sign in',
      signingMode: 'current',
      address: 't1example',
      pubkey: '02abc'
    }),
    {
      message: 'Sign in',
      signingMode: 'current',
      address: 't1example',
      pubkey: '02abc'
    }
  )
  assert.equal(parseZcashSignMessageApproval({ message: 'Sign in' }), null)
  assert.doesNotThrow(() =>
    assertReviewedDAppSigningIdentity(
      { signingMode: 'current', address: 't1example', pubkey: '02abc' },
      { signingMode: 'current', address: 't1example', pubkey: '02abc' }
    )
  )
  assert.throws(
    () =>
      assertReviewedDAppSigningIdentity(
        { signingMode: 'current', address: 't1example', pubkey: '02abc' },
        { signingMode: 'derived', address: 't1example', pubkey: '02abc' }
      ),
    /signing identity changed/
  )
})
