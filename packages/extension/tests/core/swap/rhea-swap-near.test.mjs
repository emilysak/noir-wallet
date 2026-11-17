import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  maximumNearFunctionCallFeeYocto,
  RheaSwapNearCoordinator
} from '../../../src/background/rhea-swap-near.ts'
import { parseRheaSwapNearTransactionBatchReview } from '../../../src/core/services/rhea-swap/rhea-swap-runtime.ts'
import { classifyError } from '../../../src/lib/errors.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'

const sender = 'alice.near'
const sourceHashes = ['1'.repeat(32), `${'1'.repeat(31)}2`]
const fingerprints = ['a'.repeat(64), 'b'.repeat(64)]

function binding() {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:near-one',
    executionId: 'execution-near-one',
    router: 'near-intents',
    sourceTarget: 'router.near',
    sender,
    originAmountRaw: '1000',
    expiresAt: 5_000,
    isCrossChain: true,
    origin: {
      chainId: 'near:mainnet',
      assetId: 'near:mainnet/slip44:397',
      protocolChainId: 'near',
      protocolAssetId: 'native'
    },
    destination: {
      chainId: 'zcash:mainnet',
      assetId: 'zcash:mainnet/slip44:133',
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
}

function plan() {
  return {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    chain: 'near',
    transactions: [
      {
        signerId: sender,
        receiverId: 'router.near',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'swap',
              args: { amount: '1000' },
              gas: '1000000000000',
              deposit: '1'
            }
          }
        ]
      },
      {
        signerId: sender,
        receiverId: 'recipient.near',
        actions: [{ type: 'Transfer', params: { deposit: '2' } }]
      }
    ]
  }
}

function activeContext() {
  return {
    accountIndex: 0,
    publicKey: `ed25519:${'1'.repeat(32)}`,
    keyDomainSource: { kind: 'mnemonic' },
    chainAccount: {
      id: 'chain-account-near',
      scope: {
        keyDomainId: 'wallet:near',
        accountId: 'account:near',
        chainId: 'near:mainnet'
      },
      identity: { kind: 'account-identifier', value: sender }
    }
  }
}

function createStore() {
  const values = new Map()
  return {
    values,
    async get(handle) {
      return values.get(handle) ?? null
    },
    async list() {
      return [...values.values()]
    },
    async put(value) {
      values.set(value.quoteHandle, value)
    },
    async delete(handle) {
      values.delete(handle)
    }
  }
}

function createHarness(overrides = {}) {
  let now = 1_000
  let id = 0
  let preparedIndex = 0
  let confirmedIndex = 0
  const calls = []
  const store = createStore()
  const repository = new InMemoryTransactionRepository()
  const submission = {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    router: 'near-intents',
    sourceHash: sourceHashes[1],
    orderId: 'order-near-one',
    statusChainId: 'near',
    reportStatus: 'pending'
  }
  const service = {
    async readNearTransactionBatchPlan() {
      calls.push('read-plan')
      return plan()
    },
    async recordTransactionSubmission(_handle, sourceHash) {
      calls.push(`record:${sourceHash}`)
      return submission
    },
    async reportSubmission() {
      calls.push('report')
      return submission
    },
    async discard() {
      calls.push('discard')
    },
    ...overrides.service
  }
  const signer = {
    async prepare(_keyDomainId, payload) {
      const index = preparedIndex++
      calls.push(`prepare:${index}`)
      return {
        commandId: `command-near-${index}`,
        chainId: 'near:mainnet',
        operation: 'transaction',
        summary: {
          schema: 'near.transaction.v1',
          chainId: 'near:mainnet',
          operation: 'transaction',
          review: { level: 'standard', issues: [] },
          fields: {
            signerId: sender,
            publicKey: activeContext().publicKey,
            nonce: payload.transaction.nonce,
            receiverId: payload.transaction.receiverId,
            blockHash: '1'.repeat(32),
            actions: []
          }
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprints[index] },
        execution: overrides.ledger
          ? { kind: 'external', request: { encoding: 'base64', value: 'AQ==' } }
          : { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    async confirm() {
      const index = confirmedIndex++
      calls.push(`confirm:${index}`)
      return {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: index === 0 ? 'AQ==' : 'Ag==' },
        transactionId: sourceHashes[index]
      }
    },
    async cancel(_keyDomainId, commandId) {
      calls.push(`cancel:${commandId}`)
    },
    async deriveNearPea() {
      calls.push('derive-pea')
      throw new Error('NEAR private execution was not requested')
    },
    ...overrides.signer
  }
  const rpc = {
    async assertExpectedChain() {
      calls.push('assert-chain')
    },
    async getAccessKey() {
      calls.push('access-key')
      return {
        accountId: sender,
        publicKey: activeContext().publicKey,
        nonce: '40',
        permission: { kind: 'full-access' },
        blockHash: '1'.repeat(32),
        blockHeight: 10
      }
    },
    async broadcastSignedTransactionAndWait(transaction) {
      const index = transaction === 'AQ==' ? 0 : 1
      calls.push(`commit:${index}`)
      return {
        transaction: { hash: sourceHashes[index] },
        status: { SuccessValue: '' }
      }
    },
    async getTransactionStatus() {
      calls.push('status')
      return { status: 'unknown' }
    },
    ...overrides.rpc
  }
  const coordinator = new RheaSwapNearCoordinator({
    service,
    signer,
    rpc,
    pending: store,
    repository,
    loadContext:
      overrides.loadContext ??
      (async () => ({
        ...activeContext(),
        ...(overrides.ledger ? { keyDomainSource: { kind: 'hardware', vendor: 'ledger' } } : {})
      })),
    scheduleMonitoring: async () => calls.push('schedule'),
    now: () => now,
    createId: () => `stable-near-${++id}`,
    wait: async () => {}
  })
  return {
    coordinator,
    calls,
    repository,
    store,
    setNow(value) {
      now = value
    }
  }
}

function nativeNearBinding() {
  return {
    ...binding(),
    origin: {
      ...binding().origin,
      protocolAssetId: 'nep141:wrap.near'
    }
  }
}

test('prices the quoted NEAR function-call gas ceiling without counting transfers', async () => {
  expect(
    maximumNearFunctionCallFeeYocto(
      [
        {
          actions: [
            { type: 'functionCall', gas: '3' },
            { type: 'transfer', gas: '99' }
          ]
        },
        { actions: [{ type: 'functionCall', gas: '4' }] }
      ],
      '2',
      '10'
    )
  ).toBe('70')
  const harness = createHarness({
    rpc: {
      async getGasPrice() {
        return '2'
      },
      async getNativeTransferCostConfig() {
        return { minGasPurchasePriceRaw: '5' }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  expect(review.networkFeeRaw).toBe('5000000000000')
})

test('keeps an optional NEAR network fee on the parsed signing review', () => {
  const summary = {
    schema: 'near.transaction.v1',
    chainId: 'near:mainnet',
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      signerId: '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412',
      publicKey: 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25',
      nonce: '1',
      receiverId: 'alice.near',
      blockHash: 'SysvarC1ock11111111111111111111111111111111',
      actions: [{ kind: 'transfer', depositYocto: '1' }]
    }
  }
  const review = {
    quoteHandle: 'rhea-quote:near-one',
    executionId: 'execution-near-one',
    chainId: 'near:mainnet',
    sender: summary.fields.signerId,
    summaries: [summary],
    networkFeeRaw: '70',
    payloadFingerprint: 'a'.repeat(64),
    expiresAt: 5_000
  }
  expect(parseRheaSwapNearTransactionBatchReview(review).networkFeeRaw).toBe('70')
  const { networkFeeRaw: _fee, ...withoutFee } = review
  expect(parseRheaSwapNearTransactionBatchReview(withoutFee).networkFeeRaw).toBeUndefined()
  expect(() =>
    parseRheaSwapNearTransactionBatchReview({ ...review, networkFeeRaw: '1.5' })
  ).toThrow('invalid')
})

test('merges a native NEAR wrap into the wrap.near transaction before signing', async () => {
  const prepared = []
  const nearBinding = nativeNearBinding()
  const harness = createHarness({
    service: {
      async readNearTransactionBatchPlan() {
        harness.calls.push('read-plan')
        return {
          ...plan(),
          transactions: [
            {
              signerId: sender,
              receiverId: 'wrap.near',
              actions: [
                {
                  type: 'FunctionCall',
                  params: {
                    methodName: 'ft_transfer_call',
                    args: { amount: '1000' },
                    gas: '1000000000000',
                    deposit: '1'
                  }
                }
              ]
            }
          ]
        }
      }
    },
    signer: {
      async prepare(_keyDomainId, payload) {
        prepared.push(payload.transaction)
        const index = prepared.length - 1
        return {
          commandId: `command-near-${index}`,
          chainId: 'near:mainnet',
          operation: 'transaction',
          summary: {
            schema: 'near.transaction.v1',
            chainId: 'near:mainnet',
            operation: 'transaction',
            review: { level: 'standard', issues: [] },
            fields: {
              signerId: sender,
              publicKey: activeContext().publicKey,
              nonce: payload.transaction.nonce,
              receiverId: payload.transaction.receiverId,
              blockHash: '1'.repeat(32),
              actions: []
            }
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprints[index] },
          execution: { kind: 'internal' },
          expiresAt: 5_000
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(nearBinding.quoteHandle, nearBinding)
  expect(review.summaries).toHaveLength(1)
  expect(prepared[0].receiverId).toBe('wrap.near')
  expect(prepared[0].actions.map(action => action.methodName)).toEqual([
    'storage_deposit',
    'near_deposit',
    'ft_transfer_call'
  ])
  expect(prepared[0].actions[1].depositYocto).toBe('1000')
  expect(prepared[0].actions[0].depositYocto).toBe('1250000000000000000000')
})

test('prepends native NEAR wrap and keeps it in the Ledger batch fingerprint', async () => {
  const nearBinding = nativeNearBinding()
  const harness = createHarness({
    ledger: true,
    service: {
      async readNearTransactionBatchPlan() {
        harness.calls.push('read-plan')
        return {
          quoteHandle: binding().quoteHandle,
          executionId: binding().executionId,
          chain: 'near',
          transactions: [plan().transactions[0]]
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(nearBinding.quoteHandle, nearBinding)
  expect(review.summaries.map(summary => summary.fields.receiverId)).toEqual([
    'wrap.near',
    'router.near'
  ])
  const result = await harness.coordinator.confirm(
    nearBinding.quoteHandle,
    review.payloadFingerprint
  )
  expect(result.graph.root.status).toBe('broadcast')
  expect(harness.calls.filter(call => call.startsWith('prepare:'))).toHaveLength(2)
})

test('signs and broadcasts every NEAR transaction before reporting the final hash', async () => {
  const harness = createHarness()
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  expect(harness.calls).not.toContain('derive-pea')

  expect(review.summaries).toHaveLength(2)
  const result = await harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  expect(result.graph.root.status).toBe('broadcast')
  expect(
    result.graph.segments
      .filter(segment => segment.role === 'origin')
      .map(segment => segment.evidence.transactionHash)
  ).toEqual(sourceHashes)
  expect(harness.calls).toContain(`record:${sourceHashes[1]}`)
  expect(harness.calls.indexOf('commit:1')).toBeLessThan(
    harness.calls.indexOf(`record:${sourceHashes[1]}`)
  )
  expect(() => assertPersistableTransactionGraph(result.graph)).not.toThrow()
  expect(harness.store.values.size).toBe(0)
})

test('signs a NEAR private move with the private execution account', async () => {
  const peaAddress = 'ab'.repeat(32)
  const peaPublicKey = `ed25519:${'2'.repeat(43)}`
  const prepared = []
  const accessKeys = []
  const privateBinding = {
    ...binding(),
    sender: peaAddress,
    origin: { ...binding().origin, protocolAssetId: 'nep141:wrap.near' }
  }
  const harness = createHarness({
    loadContext: async () => ({ ...activeContext(), keyDomainSource: { kind: 'software' } }),
    service: {
      async readNearTransactionBatchPlan() {
        harness.calls.push('read-plan')
        return {
          ...plan(),
          transactions: plan().transactions.map(transaction => ({
            ...transaction,
            signerId: peaAddress
          }))
        }
      }
    },
    signer: {
      async deriveNearPea() {
        harness.calls.push('derive-pea')
        return {
          address: peaAddress,
          publicKey: peaPublicKey,
          curve: 'ed25519',
          derivationScheme: 'pea_v2',
          parent: { accountIndex: 0 }
        }
      },
      async prepare(_keyDomainId, payload) {
        prepared.push(payload)
        const index = prepared.length - 1
        return {
          commandId: `command-near-${index}`,
          chainId: 'near:mainnet',
          operation: 'transaction',
          summary: {
            schema: 'near.transaction.v1',
            chainId: 'near:mainnet',
            operation: 'transaction',
            review: { level: 'standard', issues: [] },
            fields: {
              signerId: payload.transaction.signerId,
              publicKey: peaPublicKey,
              nonce: payload.transaction.nonce,
              receiverId: payload.transaction.receiverId,
              blockHash: '1'.repeat(32),
              actions: []
            }
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprints[index] },
          execution: { kind: 'internal' },
          expiresAt: 5_000
        }
      }
    },
    rpc: {
      async getAccessKey(accountId, publicKey) {
        accessKeys.push({ accountId, publicKey })
        harness.calls.push('access-key')
        return {
          accountId,
          publicKey,
          nonce: '40',
          permission: { kind: 'full-access' },
          blockHash: '1'.repeat(32),
          blockHeight: 10
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(privateBinding.quoteHandle, privateBinding)
  expect(prepared.map(payload => payload.kind)).toEqual([
    'pea-near-transaction',
    'pea-near-transaction'
  ])
  expect(prepared.every(payload => payload.transaction.signerId === peaAddress)).toBe(true)
  expect(prepared.map(payload => payload.transaction.receiverId)).toEqual([
    'router.near',
    'recipient.near'
  ])
  expect(
    prepared.some(payload =>
      payload.transaction.actions.some(action => action.methodName === 'near_deposit')
    )
  ).toBe(false)
  expect(accessKeys).toEqual([{ accountId: peaAddress, publicKey: peaPublicKey }])
  expect(review.sender).toBe(peaAddress)
  const result = await harness.coordinator.confirm(
    privateBinding.quoteHandle,
    review.payloadFingerprint
  )
  expect(result.graph.root.status).toBe('broadcast')
  expect(harness.calls.filter(call => call === 'derive-pea')).toHaveLength(2)
})

test('rejects a NEAR private move when the derived account does not match the binding', async () => {
  const harness = createHarness({
    loadContext: async () => ({ ...activeContext(), keyDomainSource: { kind: 'software' } }),
    signer: {
      async deriveNearPea() {
        return {
          address: 'cd'.repeat(32),
          publicKey: `ed25519:${'3'.repeat(43)}`,
          curve: 'ed25519',
          derivationScheme: 'pea_v2',
          parent: { accountIndex: 0 }
        }
      }
    }
  })
  await expect(
    harness.coordinator.prepare(binding().quoteHandle, { ...binding(), sender: 'ab'.repeat(32) })
  ).rejects.toThrow(/binding does not match its build/)
  expect(harness.calls).not.toContain('access-key')
})

test('continues the NEAR batch after a commit timeout once the first transaction executes', async () => {
  let firstCommitAttempted = false
  let firstStatusReads = 0
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`commit:${index}`)
        if (index === 0 && !firstCommitAttempted) {
          firstCommitAttempted = true
          throw new Error('NEAR RPC request timed out')
        }
        return {
          transaction: { hash: sourceHashes[index] },
          status: { SuccessValue: '' }
        }
      },
      async getTransactionStatus(hash) {
        harness.calls.push(`status:${hash}`)
        if (hash !== sourceHashes[0] || !firstCommitAttempted) return { status: 'unknown' }
        firstStatusReads += 1
        return { status: firstStatusReads === 1 ? 'confirming' : 'final' }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  const result = await harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)

  expect(result.graph.root.status).toBe('broadcast')
  expect(harness.calls.filter(call => call === 'commit:0')).toHaveLength(1)
  expect(harness.calls.filter(call => call === 'commit:1')).toHaveLength(1)
  expect(harness.calls.join('\n')).not.toContain('waiting to broadcast')
})

test('does not rebroadcast a NEAR transaction that is already on chain', async () => {
  let phase = 'before-commit'
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`commit:${index}`)
        if (index === 0 && phase === 'before-commit') {
          phase = 'confirming'
          throw new Error('NEAR RPC request timed out')
        }
        return {
          transaction: { hash: sourceHashes[index] },
          status: { SuccessValue: '' }
        }
      },
      async getTransactionStatus(hash) {
        harness.calls.push(`status:${hash}`)
        if (hash !== sourceHashes[0] || phase === 'before-commit') return { status: 'unknown' }
        return { status: phase === 'confirming' ? 'confirming' : 'final' }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/transaction 1 is confirming: NEAR RPC request timed out/)
  expect(harness.calls.filter(call => call === 'commit:0')).toHaveLength(1)

  phase = 'landed'
  const result = await harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  expect(result.graph.root.status).toBe('broadcast')
  expect(harness.calls.filter(call => call === 'commit:0')).toHaveLength(1)
  expect(harness.calls.filter(call => call === 'commit:1')).toHaveLength(1)
})

test('recovers a partially broadcast signed batch without signing again after expiry', async () => {
  let allowSecondBroadcast = false
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`commit:${index}`)
        if (index === 1 && !allowSecondBroadcast) throw new Error('response unavailable')
        return {
          transaction: { hash: sourceHashes[index] },
          status: { SuccessValue: '' }
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/transaction 2 is confirming: response unavailable/)
  expect(harness.calls.some(call => call.startsWith('record:'))).toBe(false)
  expect(harness.calls).not.toContain('report')

  const [pending] = await harness.store.list()
  expect(pending.signedTransactions).toHaveLength(2)
  const graph = await harness.repository.get(pending.scope, `tx:rhea-near:${pending.graphSuffix}`)
  expect(graph.segments.filter(segment => segment.role === 'origin')).toMatchObject([
    { status: 'broadcast', evidence: { transactionHash: sourceHashes[0] } },
    { status: 'signed', evidence: { transactionHash: sourceHashes[1] } }
  ])
  expect(() => assertPersistableTransactionGraph(graph)).not.toThrow()

  allowSecondBroadcast = true
  harness.setNow(6_000)
  await expect(harness.coordinator.recoverSigned()).resolves.toBe(1)
  expect(harness.calls.filter(call => call.startsWith('confirm:'))).toHaveLength(2)
  expect(harness.calls.filter(call => call === 'read-plan')).toHaveLength(2)
  expect(harness.calls.filter(call => call === 'commit:0')).toHaveLength(1)
})

test('rejects a committed NEAR execution failure without recording the submission', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`commit:${index}`)
        return {
          transaction: { hash: sourceHashes[index] },
          status: {
            Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: {} } } }
          }
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  const [preparedPending] = await harness.store.list()

  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/NEAR transaction execution failed/)
  expect(harness.calls.some(call => call.startsWith('record:'))).toBe(false)
  expect(harness.calls).not.toContain('report')
  expect(await harness.store.list()).toHaveLength(0)
  await expect(
    harness.repository.get(preparedPending.scope, `tx:rhea-near:${preparedPending.graphSuffix}`)
  ).resolves.toBeNull()
})

test('rejects a failed NEAR status after a commit error without recording the submission', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait() {
        harness.calls.push('commit:0')
        throw new Error('response unavailable')
      },
      async getTransactionStatus() {
        harness.calls.push('status')
        return { status: 'failed' }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  const [preparedPending] = await harness.store.list()

  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/NEAR transaction execution failed/)
  expect(harness.calls.some(call => call.startsWith('record:'))).toBe(false)
  expect(harness.calls).not.toContain('report')
  expect(await harness.store.list()).toHaveLength(0)
  await expect(
    harness.repository.get(preparedPending.scope, `tx:rhea-near:${preparedPending.graphSuffix}`)
  ).resolves.toBeNull()
})

test('discards a rejected NEAR broadcast without an activity record', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait() {
        harness.calls.push('commit:0')
        throw new Error('NEAR RPC request failed: InvalidNonce')
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  const [preparedPending] = await harness.store.list()

  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/transaction 1 was rejected: NEAR RPC request failed: InvalidNonce/)
  expect(harness.calls.filter(call => call === 'commit:0')).toHaveLength(1)
  expect(harness.calls.filter(call => call === 'status')).toHaveLength(1)
  expect(await harness.store.list()).toHaveLength(0)
  await expect(
    harness.repository.get(preparedPending.scope, `tx:rhea-near:${preparedPending.graphSuffix}`)
  ).resolves.toBeNull()
})

test('tells a private NEAR account to add NEAR when the fee balance is insufficient', async () => {
  const peaAddress = 'ab'.repeat(32)
  const peaPublicKey = `ed25519:${'2'.repeat(43)}`
  const harness = createHarness({
    loadContext: async () => ({ ...activeContext(), keyDomainSource: { kind: 'software' } }),
    service: {
      async readNearTransactionBatchPlan() {
        harness.calls.push('read-plan')
        return {
          ...plan(),
          transactions: plan().transactions.map(transaction => ({
            ...transaction,
            signerId: peaAddress
          }))
        }
      }
    },
    signer: {
      async deriveNearPea() {
        harness.calls.push('derive-pea')
        return {
          address: peaAddress,
          publicKey: peaPublicKey,
          curve: 'ed25519',
          derivationScheme: 'pea_v2',
          parent: { accountIndex: 0 }
        }
      },
      async prepare(_keyDomainId, payload) {
        const index = harness.calls.filter(call => call.startsWith('prepare:')).length
        harness.calls.push(`prepare:${index}`)
        return {
          commandId: `command-near-${index}`,
          chainId: 'near:mainnet',
          operation: 'transaction',
          summary: {
            schema: 'near.transaction.v1',
            chainId: 'near:mainnet',
            operation: 'transaction',
            review: { level: 'standard', issues: [] },
            fields: {
              signerId: payload.transaction.signerId,
              publicKey: peaPublicKey,
              nonce: payload.transaction.nonce,
              receiverId: payload.transaction.receiverId,
              blockHash: '1'.repeat(32),
              actions: []
            }
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprints[index] },
          execution: { kind: 'internal' },
          expiresAt: 5_000
        }
      }
    },
    rpc: {
      async broadcastSignedTransactionAndWait() {
        harness.calls.push('commit:0')
        throw new Error('NEAR RPC request failed: NotEnoughBalance')
      }
    }
  })
  const privateBinding = { ...binding(), sender: peaAddress }
  const review = await harness.coordinator.prepare(privateBinding.quoteHandle, privateBinding)

  await expect(
    harness.coordinator.confirm(privateBinding.quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('RHEA Swap NEAR private account cannot pay the network fee')
  expect(
    classifyError(new Error('RHEA Swap NEAR private account cannot pay the network fee')).userMessage
  ).toBe(
    'The private account does not have enough NEAR to pay the network fee. Send NEAR to the private account and try again.'
  )
})

test('keeps a public NEAR balance rejection on the quote retry message', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait() {
        harness.calls.push('commit:0')
        throw new Error('NEAR RPC request failed: NotEnoughBalance')
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())

  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/transaction 1 was rejected: NEAR RPC request failed: NotEnoughBalance/)
})

test('cancels every unsigned NEAR command and discards the quote', async () => {
  const harness = createHarness()
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await harness.coordinator.cancel(binding().quoteHandle)

  expect(harness.calls).toContain('cancel:command-near-0')
  expect(harness.calls).toContain('cancel:command-near-1')
  expect(harness.calls).toContain('discard')
  expect(harness.store.values.size).toBe(0)
})

test('Ledger NEAR review binds the batch and prevents concurrent confirmation', async () => {
  let changed = false
  let releaseSigning
  const signingGate = new Promise(resolve => {
    releaseSigning = resolve
  })
  const harness = createHarness({
    ledger: true,
    service: {
      async readNearTransactionBatchPlan() {
        harness.calls.push('read-plan')
        const current = plan()
        if (changed) current.transactions[1].actions[0].params.deposit = '3'
        return current
      }
    },
    signer: {
      async confirm(_keyDomainId, commandId) {
        const index = Number(commandId.at(-1))
        harness.calls.push(`confirm:${index}`)
        await signingGate
        return {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: index === 0 ? 'AQ==' : 'Ag==' },
          transactionId: sourceHashes[index]
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  changed = true
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/changed after Ledger review/)
  expect(harness.calls).not.toContain('confirm:0')

  changed = false
  const first = harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/already in progress/)
  releaseSigning()
  await expect(first).resolves.toMatchObject({ graph: { root: { status: 'broadcast' } } })
  expect(harness.calls.filter(call => call.startsWith('confirm:'))).toHaveLength(2)
})
