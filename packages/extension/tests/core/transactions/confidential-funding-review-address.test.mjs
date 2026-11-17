import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createConfidentialFundingClient } from '../../../src/popup/services/confidential-funding-client.ts'

const implicitNearAccount = 'ab'.repeat(32)
const evmAddress = `0x${'ab'.repeat(20)}`
const evmZeroAddress = `0x${'0'.repeat(40)}`
const solanaAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const payloadFingerprint = 'cd'.repeat(32)

const prepareRequest = {
  network: 'mainnet',
  keyDomainId: 'key-domain',
  accountId: 'account-1',
  operation: 'cluster',
  sourceDomain: 'public',
  destinationDomain: 'private',
  source: {
    chainId: 'near:mainnet',
    chainName: 'NEAR',
    assetId: 'near:mainnet/slip44:397',
    protocolAssetId: 'nep141:wrap.near',
    amountRaw: '1000'
  },
  destination: {
    chainId: 'near:mainnet',
    chainName: 'NEAR',
    assetId: 'near:mainnet/slip44:397',
    protocolAssetId: 'nep141:wrap.near'
  },
  slippageBps: 50
}

function review(overrides = {}) {
  return {
    planId: 'plan-review',
    transactionId: 'tx:confidential:plan-review',
    phase: 'prepared',
    payloadFingerprint,
    expiresAt: 1_800_000_000_000,
    requiresDeposit: true,
    sourceAmountRaw: '1000',
    expectedOutputRaw: '900',
    minimumOutputRaw: '800',
    sourceAddress: 'alice.near',
    destinationAddress: implicitNearAccount,
    withdrawCount: 3,
    operation: 'cluster',
    network: 'mainnet',
    keyDomainId: 'key-domain',
    accountId: 'account-1',
    sourceDomain: 'public',
    destinationDomain: 'private',
    ...overrides
  }
}

function clientFor(value) {
  return createConfidentialFundingClient(async message => {
    if (message.type !== 'PREPARE_CONFIDENTIAL_FUNDING') {
      throw new Error(`Unexpected message ${String(message.type)}`)
    }
    return { result: value }
  })
}

test('accepts a NEAR cluster review and returns its addresses unchanged', async () => {
  const sourceAddress = 'alice.near'
  const prepared = await clientFor(review()).prepare(prepareRequest)

  expect(prepared.sourceAddress).toBe(sourceAddress)
  expect(prepared.destinationAddress).toBe(implicitNearAccount)
  expect(prepared.operation).toBe('cluster')
  expect(prepared.withdrawCount).toBe(3)
  expect(prepared.phase).toBe('prepared')
  expect(prepared.network).toBe('mainnet')
  expect(prepared.sourceDomain).toBe('public')
  expect(prepared.destinationDomain).toBe('private')
})

test('rejects a cluster review whose destination is not an address', async () => {
  await expect(
    clientFor(review({ destinationAddress: 'not an address' })).prepare(prepareRequest)
  ).rejects.toThrow(/review is invalid/)
})

test('accepts an EVM review address', async () => {
  const prepared = await clientFor(
    review({
      operation: 'withdraw',
      withdrawCount: 1,
      sourceAddress: evmAddress,
      destinationAddress: evmAddress,
      sourceDomain: 'private',
      destinationDomain: 'public',
      requiresDeposit: false
    })
  ).prepare(prepareRequest)

  expect(prepared.sourceAddress).toBe(evmAddress)
  expect(prepared.destinationAddress).toBe(evmAddress)
})

test('rejects the EVM zero address', async () => {
  await expect(
    clientFor(
      review({
        operation: 'withdraw',
        withdrawCount: 1,
        sourceAddress: evmZeroAddress,
        destinationAddress: evmAddress,
        sourceDomain: 'private',
        destinationDomain: 'public',
        requiresDeposit: false
      })
    ).prepare(prepareRequest)
  ).rejects.toThrow(/review is invalid/)
})

test('accepts a Solana cluster review address', async () => {
  const prepared = await clientFor(
    review({
      sourceAddress: solanaAddress,
      destinationAddress: solanaAddress
    })
  ).prepare(prepareRequest)

  expect(prepared.sourceAddress).toBe(solanaAddress)
  expect(prepared.destinationAddress).toBe(solanaAddress)
})
