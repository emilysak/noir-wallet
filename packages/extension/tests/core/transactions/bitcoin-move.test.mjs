import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BITCOIN_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'
import { RHEA_SWAP_CHAIN_CATALOG } from '../../../src/core/services/rhea-swap/rhea-swap-model.ts'
import {
  getBitcoinMoveChains,
  resolveBitcoinMoveSource,
  selectBitcoinMoveMethod,
  selectDefaultTransferAssetId
} from '../../../src/popup/services/private-balance-transfer.ts'
import {
  assertBitcoinDirectMovePreparedOutputs,
  settleBitcoinDirectMove,
  settleBitcoinDirectMoveQuote
} from '../../../src/popup/services/move-method-estimate.ts'
import { buildShieldTransferRequest } from '../../../src/popup/services/shield-transfer.ts'

const BITCOIN_CHAIN_ID = BITCOIN_CHAIN_IDS.mainnet
const PUBLIC_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const PRIVATE_ADDRESS = 'bc1qhshj2sek7ff9e7gkhq6hsm9sdq8lr8u0dakdzc'
const DEPOSIT_ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

function bitcoinNetwork(chainId, options = {}) {
  return {
    chain: { id: chainId, family: 'bitcoin' },
    addresses: [
      {
        preferredForReceive: options.preferredForReceive !== false,
        value: options.publicAddress ?? PUBLIC_ADDRESS
      }
    ],
    ...(options.privateAddress === undefined
      ? { privateExecutionAddress: PRIVATE_ADDRESS }
      : options.privateAddress
        ? { privateExecutionAddress: options.privateAddress }
        : {})
  }
}

function account(walletSource, network = bitcoinNetwork(BITCOIN_CHAIN_ID), accountIndex = 0) {
  return { walletSource, accountIndex, networks: [network] }
}

function outputAddresses(settlement) {
  return settlement.kind === 'deposit' ? settlement.outputs.map(output => output.address) : []
}

test('BTC Move is eligible only on mainnet with the required addresses', () => {
  const software = { kind: 'software' }
  const ready = account(software)
  expect(getBitcoinMoveChains(ready, true)).toEqual({
    chainIds: [BITCOIN_CHAIN_ID],
    privateChainIds: [BITCOIN_CHAIN_ID]
  })
  expect(getBitcoinMoveChains(ready, false)).toEqual({ chainIds: [], privateChainIds: [] })
  expect(
    getBitcoinMoveChains(account(software, bitcoinNetwork(BITCOIN_CHAIN_IDS.testnet)), true)
  ).toEqual({ chainIds: [], privateChainIds: [] })
  expect(
    getBitcoinMoveChains(
      account(software, bitcoinNetwork(BITCOIN_CHAIN_ID, { preferredForReceive: false })),
      true
    )
  ).toEqual({ chainIds: [], privateChainIds: [] })
  expect(
    getBitcoinMoveChains(
      account(software, bitcoinNetwork(BITCOIN_CHAIN_ID, { privateAddress: '' })),
      true
    )
  ).toEqual({ chainIds: [BITCOIN_CHAIN_ID], privateChainIds: [] })
  expect(
    getBitcoinMoveChains(account({ kind: 'hardware', hardware: {} }), true)
  ).toEqual({ chainIds: [BITCOIN_CHAIN_ID], privateChainIds: [] })
  expect(
    getBitcoinMoveChains(account({ kind: 'private-key', chainFamily: 'eip155' }), true)
  ).toEqual({ chainIds: [BITCOIN_CHAIN_ID], privateChainIds: [] })
  expect(
    getBitcoinMoveChains(
      account({ kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' }),
      true
    )
  ).toEqual({ chainIds: [BITCOIN_CHAIN_ID], privateChainIds: [BITCOIN_CHAIN_ID] })
  expect(
    getBitcoinMoveChains(
      account({ kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'testnet' }),
      true
    )
  ).toEqual({ chainIds: [BITCOIN_CHAIN_ID], privateChainIds: [] })
  expect(
    getBitcoinMoveChains(
      account(
        { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' },
        bitcoinNetwork(BITCOIN_CHAIN_ID),
        1
      ),
      true
    )
  ).toEqual({ chainIds: [BITCOIN_CHAIN_ID], privateChainIds: [] })

  const asset = {
    chain: { chain: { id: BITCOIN_CHAIN_ID, family: 'bitcoin' } },
    asset: {
      asset: { id: `${BITCOIN_CHAIN_ID}/slip44:0`, chainId: BITCOIN_CHAIN_ID },
      balance: { totalRaw: '1000', mainRaw: '1000', privateRaw: '0' }
    }
  }
  expect(
    selectDefaultTransferAssetId({
      assets: [asset],
      from: 'public',
      to: 'private',
      eligibleChainIds: [],
      bitcoinChainIds: [BITCOIN_CHAIN_ID]
    })
  ).toBe(asset.asset.asset.id)
  expect(
    selectDefaultTransferAssetId({
      assets: [asset],
      from: 'public',
      to: 'private',
      eligibleChainIds: [],
      bitcoinChainIds: []
    })
  ).toBeNull()

  expect(
    resolveBitcoinMoveSource({
      from: 'private',
      to: 'public',
      mainAddress: PUBLIC_ADDRESS,
      privateAddress: '',
      privateAvailable: false,
      balanceRaw: '1000'
    })
  ).toBeNull()
  expect(
    resolveBitcoinMoveSource({
      from: 'private',
      to: 'shield',
      mainAddress: PUBLIC_ADDRESS,
      privateAddress: PRIVATE_ADDRESS,
      privateAvailable: true,
      balanceRaw: '1000'
    })
  ).toMatchObject({ sender: PRIVATE_ADDRESS, recipient: PUBLIC_ADDRESS, executionMode: 'private' })
})

test('a failed Bitcoin quote does not produce a wallet-to-wallet transfer', async () => {
  const chain = {
    chain: {
      id: BITCOIN_CHAIN_ID,
      family: 'bitcoin',
      network: { kind: 'mainnet' }
    }
  }
  const asset = {
    asset: {
      id: `${BITCOIN_CHAIN_ID}/slip44:0`,
      chainId: BITCOIN_CHAIN_ID,
      namespace: 'slip44',
      reference: '0',
      kind: 'native'
    },
    metadata: { name: 'Bitcoin', symbol: 'BTC', decimals: 8 }
  }
  const tokenListChainId = RHEA_SWAP_CHAIN_CATALOG.find(
    entry => entry.walletFamily === 'bitcoin'
  ).tokenListChainId
  const token = {
    assetId: 'nep141:btc.omft.near',
    blockchain: 'btc',
    decimals: 8,
    symbol: 'BTC',
    rheaChainId: 'btc',
    rheaAddress: 'btc',
    isNative: true
  }
  const input = {
    asset,
    chain,
    nativeFeeAsset: null,
    amountRaw: '1000',
    sender: PRIVATE_ADDRESS,
    recipient: PUBLIC_ADDRESS,
    executionMode: 'private',
    signal: new AbortController().signal
  }
  const transferCalls = []
  const failed = await settleBitcoinDirectMove(input, {
    listTokens: async request => {
      expect(request.tokenListChainIds).toEqual([tokenListChainId])
      return { tokens: [token] }
    },
    quote: async (request, purpose) => {
      expect(request).toMatchObject({
        fromChain: 'btc',
        toChain: 'btc',
        sender: PRIVATE_ADDRESS,
        recipient: PUBLIC_ADDRESS,
        confidentiality: 'basic',
        tokenIn: { address: 'btc', chain: 'btc' },
        tokenOut: { address: 'btc', chain: 'btc' }
      })
      expect(purpose).toBe('private-transfer')
      throw new Error('no route')
    },
    prepare: async () => {
      throw new Error('prepare should not run after a failed quote')
    },
    discard: async () => {},
    prepareTransfer: recipient => {
      transferCalls.push(recipient)
    }
  })
  expect(failed).toEqual({ kind: 'stop', error: 'no route' })
  expect(outputAddresses(failed)).toEqual([])
  expect(transferCalls).toEqual([])
  expect(JSON.stringify(failed)).not.toContain(PUBLIC_ADDRESS)

  const discarded = []
  const walletToWallet = await settleBitcoinDirectMove(
    { ...input, executionMode: 'main', sender: PUBLIC_ADDRESS, recipient: PRIVATE_ADDRESS },
    {
      listTokens: async () => ({ tokens: [token] }),
      quote: async (_request, purpose) => {
        expect(purpose).toBe('confidential-funding')
        return { quoteHandle: 'quote-1', estimatedOut: '900', expiresAt: null }
      },
      prepare: async () => ({
        execution: { kind: 'bitcoin-transfer', target: PRIVATE_ADDRESS }
      }),
      discard: async handle => {
        discarded.push(handle)
      },
      prepareTransfer: recipient => {
        transferCalls.push(recipient)
      }
    }
  )
  expect(walletToWallet).toEqual({
    kind: 'stop',
    error: 'Bitcoin move must pay the quote deposit address.'
  })
  expect(outputAddresses(walletToWallet)).toEqual([])
  expect(discarded).toEqual(['quote-1'])
  expect(transferCalls).toEqual([])

  const missingRoute = settleBitcoinDirectMoveQuote({
    chainId: BITCOIN_CHAIN_ID,
    sourceAddress: PUBLIC_ADDRESS,
    counterpartyAddress: PRIVATE_ADDRESS,
    quote: {
      failed: false,
      routeMissing: true,
      executionKind: 'bitcoin-transfer',
      depositAddress: DEPOSIT_ADDRESS
    }
  })
  expect(missingRoute.kind).toBe('stop')
  expect(outputAddresses(missingRoute)).toEqual([])

  const otherExecution = settleBitcoinDirectMoveQuote({
    chainId: BITCOIN_CHAIN_ID,
    sourceAddress: PUBLIC_ADDRESS,
    counterpartyAddress: PRIVATE_ADDRESS,
    quote: {
      failed: false,
      routeMissing: false,
      executionKind: 'near-transaction-batch',
      depositAddress: DEPOSIT_ADDRESS
    }
  })
  expect(otherExecution.kind).toBe('stop')
  expect(outputAddresses(otherExecution)).toEqual([])

  const deposit = settleBitcoinDirectMoveQuote({
    chainId: BITCOIN_CHAIN_ID,
    sourceAddress: PUBLIC_ADDRESS,
    counterpartyAddress: PRIVATE_ADDRESS,
    quote: {
      failed: false,
      routeMissing: false,
      executionKind: 'bitcoin-transfer',
      depositAddress: DEPOSIT_ADDRESS
    }
  })
  expect(deposit).toMatchObject({
    kind: 'deposit',
    sourceAddress: PUBLIC_ADDRESS,
    depositAddress: DEPOSIT_ADDRESS
  })
  expect(outputAddresses(deposit)).toEqual([DEPOSIT_ADDRESS])
  expect(outputAddresses(deposit)).not.toContain(PRIVATE_ADDRESS)
  expect(outputAddresses(deposit)).not.toContain(PUBLIC_ADDRESS)

  const walletTarget = settleBitcoinDirectMoveQuote({
    chainId: BITCOIN_CHAIN_ID,
    sourceAddress: PUBLIC_ADDRESS,
    counterpartyAddress: PRIVATE_ADDRESS,
    quote: {
      failed: false,
      routeMissing: false,
      executionKind: 'bitcoin-transfer',
      depositAddress: PRIVATE_ADDRESS
    }
  })
  expect(walletTarget).toEqual({
    kind: 'stop',
    error: 'Bitcoin move must pay the quote deposit address.'
  })
  expect(outputAddresses(walletTarget)).toEqual([])

  const summary = (recipient, amountSats, extra = []) => ({
    schema: 'bitcoin.psbt.v1',
    fields: {
      outputs: [
        { address: recipient, amountSats, classification: 'recipient' },
        ...extra
      ]
    }
  })
  expect(() =>
    assertBitcoinDirectMovePreparedOutputs({
      depositAddress: DEPOSIT_ADDRESS,
      amountRaw: '1000',
      summary: summary(DEPOSIT_ADDRESS, '1000', [
        { address: PUBLIC_ADDRESS, amountSats: '50', classification: 'change' }
      ])
    })
  ).not.toThrow()
  expect(() =>
    assertBitcoinDirectMovePreparedOutputs({
      depositAddress: DEPOSIT_ADDRESS,
      amountRaw: '1000',
      summary: summary(PRIVATE_ADDRESS, '1000')
    })
  ).toThrow('Bitcoin move must pay the quote deposit address.')
  expect(() =>
    assertBitcoinDirectMovePreparedOutputs({
      depositAddress: DEPOSIT_ADDRESS,
      amountRaw: '1000',
      summary: summary(DEPOSIT_ADDRESS, '900')
    })
  ).toThrow('Bitcoin move must pay the quote deposit address.')
  expect(() =>
    assertBitcoinDirectMovePreparedOutputs({
      depositAddress: DEPOSIT_ADDRESS,
      amountRaw: '1000',
      summary: {
        schema: 'bitcoin.psbt.v1',
        fields: {
          outputs: [
            { address: DEPOSIT_ADDRESS, amountSats: '1000', classification: 'recipient' },
            { address: PRIVATE_ADDRESS, amountSats: '1', classification: 'recipient' }
          ]
        }
      }
    })
  ).toThrow('Bitcoin move must pay the quote deposit address.')
})

test('Bitcoin Cluster and Directly are not auto-switched when a quote fails', () => {
  expect(
    selectBitcoinMoveMethod({
      method: 'cluster',
      clusterQuoteFailed: true,
      directQuoteFailed: false
    })
  ).toBe('cluster')
  expect(
    selectBitcoinMoveMethod({
      method: 'directly',
      clusterQuoteFailed: false,
      directQuoteFailed: true
    })
  ).toBe('directly')
  expect(
    selectBitcoinMoveMethod({
      method: 'cluster',
      clusterQuoteFailed: false,
      directQuoteFailed: true
    })
  ).toBe('cluster')
  expect(
    selectBitcoinMoveMethod({
      method: 'directly',
      clusterQuoteFailed: true,
      directQuoteFailed: false
    })
  ).toBe('directly')

  const chain = {
    chain: {
      id: BITCOIN_CHAIN_ID,
      family: 'bitcoin',
      capabilities: { transaction: { status: 'available' } }
    }
  }
  const asset = {
    asset: { id: `${BITCOIN_CHAIN_ID}/slip44:0`, chainId: BITCOIN_CHAIN_ID },
    metadata: { decimals: 8, symbol: 'BTC' }
  }
  const managed = {
    assetId: asset.asset.id,
    chainId: BITCOIN_CHAIN_ID,
    protocolAssetId: 'nep141:btc.omft.near',
    blockchain: 'btc'
  }
  const request = {
    network: 'mainnet',
    keyDomainId: 'wallet',
    accountId: 'account',
    amountRaw: '1000',
    asset,
    chain,
    managed
  }
  expect(
    buildShieldTransferRequest({ ...request, from: 'public', to: 'private', method: 'cluster' })
  ).toMatchObject({
    operation: 'cluster',
    sourceDomain: 'public',
    destinationDomain: 'private',
    source: { protocolAssetId: 'nep141:btc.omft.near', amountRaw: '1000' }
  })
  expect(
    buildShieldTransferRequest({ ...request, from: 'private', to: 'shield', method: 'directly' })
  ).toMatchObject({ operation: 'deposit', sourceDomain: 'private', destinationDomain: 'shield' })
  expect(
    buildShieldTransferRequest({ ...request, from: 'shield', to: 'public', method: 'directly' })
  ).toMatchObject({ operation: 'withdraw', sourceDomain: 'shield', destinationDomain: 'public' })
  expect(
    buildShieldTransferRequest({ ...request, from: 'shield', to: 'private', method: 'directly' })
  ).toMatchObject({ operation: 'withdraw', sourceDomain: 'shield', destinationDomain: 'private' })
  expect(() =>
    buildShieldTransferRequest({ ...request, from: 'shield', to: 'public', method: 'cluster' })
  ).toThrow('Shield transfer is unavailable')
  expect(() =>
    buildShieldTransferRequest({
      ...request,
      network: 'testnet',
      from: 'public',
      to: 'shield',
      method: 'directly'
    })
  ).toThrow('Shield transfer is unavailable')
})
