import { test } from 'node:test'
import { expect } from '@playwright/test'

import { nearPublicKeyFromImplicitAccountId } from '../../../../src/core/chains/near/identifiers.ts'
import {
  ChromeSessionNearFullAccessKeyRemovalStore,
  NEAR_FULL_ACCESS_KEY_REMOVAL_OBSERVATION_MS,
  NearFullAccessKeyDeletionRefused,
  pollNearFullAccessKeyRemovals,
  selectNearCrossCheckRpcUrl,
  selectRetainedNearFullAccessKey,
  usableNearPublicKeys
} from '../../../../src/infrastructure/chains/near/index.ts'

const chainId = 'near:testnet'
const signerId = 'alice.testnet'
const deleted = nearPublicKeyFromImplicitAccountId('00'.repeat(32))
const retained = nearPublicKeyFromImplicitAccountId('11'.repeat(32))
const transactionId = '11111111111111111111111111111111'
const blockHash = transactionId

function fullAccess(publicKey) {
  return { publicKey, permission: { kind: 'full-access' } }
}

function functionCall(publicKey) {
  return {
    publicKey,
    permission: {
      kind: 'function-call',
      allowanceRaw: null,
      receiverId: 'contract.testnet',
      methodNames: []
    }
  }
}

function record(recordedAt = 0) {
  return {
    chainId,
    transactionId,
    signerId,
    deletedPublicKey: deleted,
    retainedPublicKey: retained,
    recordedAt
  }
}

function rpc(status, keys) {
  return {
    assertExpectedChain: async () => {},
    getTransactionStatus: async () => ({ status }),
    getAccessKey: async (_accountId, publicKey) => keys[publicKey] ?? null
  }
}

function memoryStorage() {
  const values = {}
  return {
    get: async keys => {
      if (keys === null) return structuredClone(values)
      return Object.prototype.hasOwnProperty.call(values, keys)
        ? { [keys]: structuredClone(values[keys]) }
        : {}
    },
    set: async items => Object.assign(values, structuredClone(items)),
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
    }
  }
}

test('requires another wallet-held full-access key before deletion', () => {
  expect(
    selectRetainedNearFullAccessKey({
      keys: [
        fullAccess(deleted),
        fullAccess(retained),
        functionCall(nearPublicKeyFromImplicitAccountId('22'.repeat(32)))
      ],
      deletedPublicKeys: [deleted],
      walletPublicKeys: [deleted, retained]
    })
  ).toEqual({
    kind: 'authorized',
    retainedPublicKey: retained,
    deletedFullAccessPublicKeys: [deleted]
  })

  expect(() =>
    selectRetainedNearFullAccessKey({
      keys: [fullAccess(deleted), functionCall(retained)],
      deletedPublicKeys: [deleted],
      walletPublicKeys: [deleted, retained]
    })
  ).toThrow(NearFullAccessKeyDeletionRefused)
  expect(() =>
    selectRetainedNearFullAccessKey({
      keys: [fullAccess(retained)],
      deletedPublicKeys: [deleted],
      walletPublicKeys: [retained]
    })
  ).toThrow(/was not found/)
  expect(
    selectRetainedNearFullAccessKey({
      keys: [functionCall(deleted), fullAccess(retained)],
      deletedPublicKeys: [deleted],
      walletPublicKeys: [retained]
    })
  ).toEqual({ kind: 'not-full-access' })
})

test('collects implicit NEAR public keys for one key domain', () => {
  const keyDomainId = 'key-domain:near'
  const chainAccountId = 'chain-account:near:0'
  expect(
    usableNearPublicKeys({
      keyDomainId,
      chainId,
      chainAccounts: [
        {
          id: chainAccountId,
          scope: { keyDomainId, accountId: 'account:near:0', chainId }
        },
        {
          id: 'chain-account:other',
          scope: { keyDomainId: 'key-domain:other', accountId: 'account:near:1', chainId }
        }
      ],
      addresses: [
        { chainAccountId, scheme: 'near', value: '11'.repeat(32) },
        { chainAccountId, scheme: 'near', value: 'alice.testnet' },
        { chainAccountId: 'chain-account:other', scheme: 'near', value: '22'.repeat(32) }
      ]
    })
  ).toEqual([retained])
})

test('selects a distinct managed RPC and skips a custom endpoint', () => {
  expect(
    selectNearCrossCheckRpcUrl({
      primaryRpcUrl: 'https://rpc.testnet.near.org',
      endpointUrls: ['https://rpc.testnet.near.org/', 'https://test.rpc.fastnear.com'],
      customEndpoint: false
    })
  ).toBe('https://test.rpc.fastnear.com/')
  expect(
    selectNearCrossCheckRpcUrl({
      primaryRpcUrl: 'https://rpc.testnet.near.org',
      endpointUrls: ['https://rpc.testnet.near.org'],
      customEndpoint: false
    })
  ).toBeNull()
  expect(
    selectNearCrossCheckRpcUrl({
      primaryRpcUrl: 'https://custom.example',
      endpointUrls: ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com'],
      customEndpoint: true
    })
  ).toBeNull()
})

test('verifies a finalized deletion on both RPCs and keeps disagreements pending', async () => {
  const removed = {
    [deleted]: null,
    [retained]: { permission: { kind: 'full-access' } }
  }
  const primary = rpc('final', removed)
  const secondary = rpc('final', removed)
  await expect(
    pollNearFullAccessKeyRemovals({
      records: [record()],
      now: 1_000,
      primary,
      secondary
    })
  ).resolves.toMatchObject({ verified: [record()], pending: 0, errors: 0 })

  await expect(
    pollNearFullAccessKeyRemovals({
      records: [record()],
      now: 1_000,
      primary,
      secondary: null
    })
  ).resolves.toMatchObject({ verified: [record()], pending: 0 })

  const disagreed = rpc('final', {
    [deleted]: { permission: { kind: 'full-access' } },
    [retained]: { permission: { kind: 'full-access' } }
  })
  await expect(
    pollNearFullAccessKeyRemovals({
      records: [record()],
      now: 1_000,
      primary,
      secondary: disagreed
    })
  ).resolves.toMatchObject({ verified: [], pending: 1, errors: 0 })

  const unavailable = {
    ...rpc('final', removed),
    assertExpectedChain: async () => {
      throw new Error('chain mismatch')
    }
  }
  await expect(
    pollNearFullAccessKeyRemovals({
      records: [record()],
      now: 1_000,
      primary,
      secondary: unavailable
    })
  ).resolves.toMatchObject({ verified: [], pending: 1, errors: 0 })
})

test('drops an unknown deletion after the observation window without confirming it', async () => {
  const unknown = rpc('unknown', {})
  await expect(
    pollNearFullAccessKeyRemovals({
      records: [record(0)],
      now: 1_000,
      primary: unknown,
      secondary: null
    })
  ).resolves.toMatchObject({ unconfirmed: [], pending: 1 })
  await expect(
    pollNearFullAccessKeyRemovals({
      records: [record(0)],
      now: NEAR_FULL_ACCESS_KEY_REMOVAL_OBSERVATION_MS,
      primary: unknown,
      secondary: null
    })
  ).resolves.toMatchObject({ unconfirmed: [record(0)], verified: [], pending: 0 })
  await expect(
    pollNearFullAccessKeyRemovals({
      records: [record(0)],
      now: 1_000,
      primary: rpc('failed', {}),
      secondary: null
    })
  ).resolves.toMatchObject({ unconfirmed: [record(0)], verified: [] })
})

test('round-trips a pending full-access key removal without the signed transaction', async () => {
  const store = new ChromeSessionNearFullAccessKeyRemovalStore(memoryStorage())
  const removal = record(1_500)
  await store.recordRemoval(removal)
  await expect(store.listRemovals(chainId)).resolves.toEqual([removal])
  await store.deleteRemoval(removal)
  await expect(store.listRemovals(chainId)).resolves.toEqual([])
})
