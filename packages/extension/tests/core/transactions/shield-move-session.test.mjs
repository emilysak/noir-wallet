import { test } from 'node:test'
import { expect } from '@playwright/test'

import { clusterNetworkFeeRequest } from '../../../src/popup/services/shield-transfer.ts'
import {
  nextShieldSessionProbe,
  shouldProbeShieldSession
} from '../../../src/popup/services/shield-session-check.ts'

const readyProbe = {
  active: true,
  enabled: true,
  settled: true,
  authorizeOnMount: true,
  attempted: false
}

test('fresh Shield balances still require a session probe', () => {
  expect(shouldProbeShieldSession({ ...readyProbe, hasFreshBalances: true })).toBe(true)
  expect(shouldProbeShieldSession({ ...readyProbe, hasFreshBalances: false })).toBe(true)
  expect(
    shouldProbeShieldSession({ ...readyProbe, hasFreshBalances: true, authorizeOnMount: false })
  ).toBe(false)
  expect(
    shouldProbeShieldSession({ ...readyProbe, hasFreshBalances: true, attempted: true })
  ).toBe(false)
  expect(
    shouldProbeShieldSession({ ...readyProbe, hasFreshBalances: true, settled: false })
  ).toBe(false)
})

test('a missing Shield session authorizes instead of staying on the page', () => {
  expect(
    nextShieldSessionProbe({
      ok: false,
      authorize: false,
      errorCode: 'authorization_required',
      retries: 0
    })
  ).toBe('authorize')
  expect(
    nextShieldSessionProbe({
      ok: true,
      authorize: true,
      errorCode: null,
      retries: 0
    })
  ).toBe('done')
  expect(
    nextShieldSessionProbe({
      ok: false,
      authorize: true,
      errorCode: 'authorization_required',
      retries: 0
    })
  ).toBe('stop')
  expect(
    nextShieldSessionProbe({
      ok: false,
      authorize: false,
      errorCode: 'balance_unavailable',
      retries: 0
    })
  ).toBe('retry')
  expect(
    nextShieldSessionProbe({
      ok: false,
      authorize: false,
      errorCode: 'balance_unavailable',
      retries: 3
    })
  ).toBe('stop')
})

test('cluster network fee preview stays on EVM', () => {
  const request = { operation: 'cluster', source: { chainId: 'near:mainnet' } }
  const feeSelection = { kind: 'tier', tier: 'standard' }
  expect(clusterNetworkFeeRequest('evm', request, feeSelection)).toEqual({
    ...request,
    feeSelection
  })
  expect(clusterNetworkFeeRequest('near', request, feeSelection)).toBeNull()
  expect(clusterNetworkFeeRequest('solana', request, feeSelection)).toBeNull()
  expect(clusterNetworkFeeRequest('bitcoin', request, feeSelection)).toBeNull()
})
