import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  ConfidentialFundingApi,
  ConfidentialFundingApiError
} from '../../../src/background/confidential-funding-api.ts'
import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import { ConfidentialFundingSigner } from '../../../src/background/confidential-funding-signer.ts'
import { createBitcoinConfidentialDepositClient } from '../../../src/background/bitcoin-confidential-deposit-client.ts'
import { setBitcoinPrivateExecutionAddressReader } from '../../../src/background/bitcoin-private-execution-address.ts'
import { createBackgroundConfidentialFundingCoordinator } from '../../../src/background/confidential-funding.ts'
import { userEvmAssetToDefinition } from '../../../src/core/chains/user-assets/user-evm-asset.ts'
import { getActiveChainEndpointSettings } from '../../../src/core/chains/chain-endpoint-settings.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'
import {
  createExternalShieldDepositGraph,
  isExternalShieldDepositAutoHidden,
  isExternalShieldDepositPending,
  shouldAutoRefreshExternalShieldDeposit,
  projectExternalShieldDepositActivityGraph
} from '../../../src/core/services/confidential-funding/confidential-external-deposit.ts'

import {
  aggregateConfidentialSettlement,
  assertDirectConfidentialWithdrawIntentBinding,
  assertConfidentialIntentBinding,
  assertConfidentialQuoteBinding,
  fingerprintConfidentialValue,
  mergeConfidentialWithdrawObservation,
  splitConfidentialFundingAmount
} from '../../../src/core/services/confidential-funding/confidential-funding-model.ts'
import { confidentialPrivateTokenId } from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'
import { confidentialIntentsAccountId } from '../../../src/core/chains/solana/identifiers.ts'
import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'
import {
  availableDepositTokens,
  defaultDepositRefundAddress,
  depositRefundAddressError,
  depositSourceAssetId,
  depositStatusLabel,
  canPayShieldDeposit,
  depositSourceNetworks,
  depositTokenChainId,
  depositTokenForNetwork,
  formatDepositAmount,
  formatMinimumDepositPaymentAmount,
  listDepositTokenChoices
} from '../../../src/popup/services/shield-deposit-options.ts'
import { listShieldFundingAssets } from '../../../src/popup/services/shield-transfer.ts'
import { getBitcoinChainId } from '../../../src/core/chains/registry/index.ts'
import {
  assertBitcoinDepositOutputs
} from '../../../src/core/services/confidential-funding/bitcoin-confidential-deposit.ts'
import {
  buildBitcoinPsbt,
  selectBitcoinCoins
} from '../../../src/infrastructure/chains/bitcoin/index.ts'
import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib, networks, payments, Transaction } from 'bitcoinjs-lib'

test('minimum deposit display rounds up without changing the exact payment amount', () => {
  const raw = '8000000000000000001'
  expect(formatMinimumDepositPaymentAmount(raw, 18)).toBe('8.000001')
  expect(formatDepositAmount(raw, 18)).toBe('8.000000000000000001')
})

test('uses the selected EVM private refund address while Zcash retains a transparent refund', () => {
  const publicAddress = '0x1111111111111111111111111111111111111111'
  const privateAddress = '0x2222222222222222222222222222222222222222'
  const zcashAddress = 't1QexampleTransparentAddress'
  const nearPrivate = 'a'.repeat(64)
  const nearPublic = 'public.near'
  const solanaPublic = '11111111111111111111111111111111'
  const evm = { id: 'eip155:56', family: 'evm' }
  const zcash = { id: 'zcash:mainnet', family: 'zcash' }
  const near = { id: 'near:mainnet', family: 'near' }
  const solana = { id: 'solana:mainnet', family: 'solana' }
  const networks = [
    {
      chain: evm,
      privateExecutionAddress: privateAddress,
      addresses: [{ value: publicAddress, privacy: 'transparent' }]
    },
    {
      chain: zcash,
      addresses: [{ value: zcashAddress, privacy: 'transparent' }]
    },
    {
      chain: near,
      privateExecutionAddress: nearPrivate,
      addresses: [
        { value: 'other.near', privacy: 'transparent', preferredForReceive: false },
        { value: nearPublic, privacy: 'transparent', preferredForReceive: true }
      ]
    },
    {
      chain: solana,
      addresses: [
        { value: 'other-solana', privacy: 'transparent', preferredForReceive: false },
        { value: solanaPublic, privacy: 'transparent', preferredForReceive: true }
      ]
    }
  ]
  expect(defaultDepositRefundAddress(evm, networks)).toBe(privateAddress)
  expect(defaultDepositRefundAddress(zcash, networks)).toBe(zcashAddress)
  expect(defaultDepositRefundAddress(near, networks)).toBe(nearPrivate)
  expect(
    defaultDepositRefundAddress(near, [
      {
        chain: near,
        addresses: networks.find(network => network.chain === near).addresses
      }
    ])
  ).toBe(nearPublic)
  expect(defaultDepositRefundAddress(solana, networks)).toBe(solanaPublic)
  expect(depositRefundAddressError(nearPrivate, near)).toBeNull()
  expect(depositRefundAddressError(nearPublic, near)).toBeNull()
  expect(depositRefundAddressError('NOT AN ACCOUNT', near)).toBe('Enter a valid NEAR account')
  expect(depositRefundAddressError(solanaPublic, solana)).toBeNull()
  expect(depositRefundAddressError('not-solana', solana)).toBe('Enter a valid Solana address')
  const bitcoinPublic = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
  const bitcoinPrivate = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
  const bitcoin = { id: getBitcoinChainId('mainnet'), family: 'bitcoin' }
  expect(
    defaultDepositRefundAddress(bitcoin, [
      {
        chain: bitcoin,
        privateExecutionAddress: bitcoinPrivate,
        addresses: [
          { value: bitcoinPrivate, privacy: 'transparent', preferredForReceive: false },
          { value: bitcoinPublic, privacy: 'transparent', preferredForReceive: true }
        ]
      }
    ])
  ).toBe(bitcoinPublic)
  expect(depositRefundAddressError(bitcoinPublic, bitcoin)).toBeNull()
  expect(depositRefundAddressError(bitcoinPrivate, bitcoin)).toBeNull()
  expect(depositRefundAddressError('not-bitcoin', bitcoin)).toBe('Enter a valid Bitcoin address')
})

test('NEAR external deposits keep the EVM confidential signer and a NEAR refund address', async () => {
  const signerId = '0x1111111111111111111111111111111111111111'
  const refundAddress = 'a'.repeat(64)
  const depositAddress = 'bridge.near'
  const protocolAssetId = 'nep141:usdt.tether-token.near'
  const assetId = 'near:mainnet/nep141:usdt.tether-token.near'
  const source = {
    chainId: 'near:mainnet',
    chainName: 'NEAR',
    assetId,
    protocolAssetId,
    amountRaw: '1000'
  }
  const records = new Map()
  const repository = new InMemoryTransactionRepository()
  let identityChainId
  let depositAddressOverride
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    api: {
      async quote(request) {
        return {
          correlationId: 'near-external-quote',
          quoteRequest: {
            swapType: 'EXACT_INPUT',
            confidentiality: 'basic',
            originAsset: request.originAsset,
            destinationAsset: request.destinationAsset,
            amount: request.amountRaw,
            refundTo: request.refundTo,
            depositType: request.depositType,
            refundType: request.refundType,
            recipient: request.recipient,
            recipientType: request.recipientType,
            slippageTolerance: request.slippageBps
          },
          quote: {
            amountIn: request.amountRaw,
            amountOut: request.amountRaw,
            minAmountOut: request.amountRaw,
            depositAddress: depositAddressOverride ?? depositAddress,
            deadline: new Date(60_000).toISOString()
          }
        }
      }
    },
    store: {
      async getExternalDeposit(id) {
        return records.get(id) ?? null
      },
      async listExternalDeposits() {
        return [...records.values()]
      },
      async listPlans() {
        return []
      },
      async putExternalDeposit(record) {
        records.set(record.depositId, record)
      },
      async withExternalDepositScope(_scope, operation) {
        return operation()
      },
      async getSession() {
        return { accessToken: 'synthetic', expiresAt: 1_000_000 }
      }
    },
    signer: {
      async resolveIdentity(chainId) {
        identityChainId = chainId
        return {
          address: signerId,
          addressIndex: 0,
          peaAddress: signerId,
          context: {
            chainAccount: {
              scope: {
                keyDomainId: 'wallet:one',
                accountId: 'account:one',
                chainId
              }
            }
          }
        }
      }
    },
    repository,
    assets: {
      get: id =>
        id === assetId
          ? { asset: { namespace: 'nep141' }, metadata: { symbol: 'USDT', decimals: 6 } }
          : undefined
    },
    protocolTokens: [
      {
        assetId: protocolAssetId,
        blockchain: 'near',
        contractAddress: 'usdt.tether-token.near',
        decimals: 6,
        symbol: 'USDT'
      }
    ],
    evmNetworks: getEvmNetworkConfigs('mainnet'),
    assetMappings: [{ assetId, protocolAssetId }],
    now: () => 1_000,
    createId: () => 'near-external-one',
    scheduleMonitoring: async () => {}
  })
  const created = await coordinator.createExternalDeposit({
    network: 'mainnet',
    keyDomainId: 'wallet:one',
    accountId: 'account:one',
    source,
    refundAddress,
    requestId: 'near-create'
  })
  expect(created.signerId).toBe(signerId)
  expect(created.refundAddress).toBe(refundAddress)
  expect(created.depositAddress).toBe(depositAddress)
  expect(identityChainId.startsWith('eip155:')).toBe(true)
  await expect(
    coordinator.createExternalDeposit({
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      refundAddress: 'NOT AN ACCOUNT',
      requestId: 'near-invalid-refund'
    })
  ).rejects.toThrow('refund address is invalid')
  depositAddressOverride = 'INVALID ADDRESS'
  await expect(
    coordinator.createExternalDeposit({
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      refundAddress,
      requestId: 'near-invalid-deposit'
    })
  ).rejects.toThrow('invalid deposit address')
  expect(records.size).toBe(1)
})

test('offers current BNB deposits without exposing the deprecated protocol token', () => {
  const bnb = { id: 'eip155:56', family: 'evm' }
  const current = {
    assetId: 'nep141:bnb.omdep.near',
    blockchain: 'bsc',
    symbol: 'BNB',
    decimals: 18
  }
  const deprecated = {
    ...current,
    assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
    symbol: 'BNB(DEPRECATED)'
  }
  expect(depositSourceAssetId(current, bnb)).toBe('eip155:56/slip44:714')
  expect(availableDepositTokens([deprecated, current], [bnb])).toEqual([current])
})

test('resolves the selected deposit token only on the explicitly selected network', () => {
  const ethereum = { id: 'eip155:1' }
  const base = { id: 'eip155:8453' }
  const tokens = [
    { assetId: 'nep141:eth-usdc', blockchain: 'eth', symbol: 'USDC' },
    { assetId: 'nep141:base-usdc', blockchain: 'base', symbol: 'USDC' }
  ]

  const choice = listDepositTokenChoices(tokens)[0]
  expect(choice.assetIds).toEqual(['nep141:eth-usdc', 'nep141:base-usdc'])
  expect(depositTokenForNetwork(tokens, choice.id, null)).toBeNull()
  expect(depositTokenForNetwork(tokens, choice.id, ethereum)?.assetId).toBe('nep141:eth-usdc')
  expect(depositTokenForNetwork(tokens, choice.id, base)?.assetId).toBe('nep141:base-usdc')

  const sameChainToken = { assetId: 'nep141:base-other-usdc', blockchain: 'base', symbol: 'USDC' }
  const collidingTokens = [...tokens, sameChainToken]
  const choices = listDepositTokenChoices(collidingTokens)
  expect(choices.map(item => item.assetIds)).toEqual([
    ['nep141:eth-usdc'],
    ['nep141:base-usdc'],
    ['nep141:base-other-usdc']
  ])
  expect(depositTokenForNetwork(collidingTokens, choices[2].id, base)?.assetId).toBe(
    sameChainToken.assetId
  )
  expect(depositTokenForNetwork(collidingTokens, choices[2].id, ethereum)).toBeNull()
  expect(depositTokenForNetwork(collidingTokens, 'symbol:usdc', base)).toBeNull()
})

const apiConfig = {
  oneClickApiUrl: 'https://example.test/1click',
  oneClickDirectApiUrl: 'https://direct.example.test/v0',
  rheaSwapApiUrl: 'https://example.test'
}

test.describe('confidential funding safety rules', () => {
  test('persisted catalog assets do not shadow verified receiving assets or bypass quarantine checks', t => {
    for (const key of ['__CONFIDENTIAL_ONE_CLICK_API_URL__', '__RHEA_SWAP_ACCESS_TOKEN__']) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, key)
      Object.defineProperty(globalThis, key, { value: '', configurable: true })
      t.after(() => {
        if (previous) Object.defineProperty(globalThis, key, previous)
        else delete globalThis[key]
      })
    }
    const network = getEvmNetworkConfigs('mainnet')
    for (const [chainId, blockchain, contractAddress, decimals, protocolAssetId] of [
      [
        'eip155:1',
        'eth',
        '0xdac17f958d2ee523a2206206994597c13d831ec7',
        6,
        'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near'
      ],
      [
        'eip155:56',
        'bsc',
        '0x55d398326f99059ff775485246999027b3197955',
        18,
        'nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near'
      ]
    ]) {
      const assetId = `${chainId}/erc20:${contractAddress}`
      const token = {
        assetId: protocolAssetId,
        blockchain,
        contractAddress,
        decimals,
        symbol: 'USDT'
      }
      const definition = userEvmAssetToDefinition({
        chainId,
        contractAddress,
        assetId,
        source: 'intents-catalog',
        addedAt: 1,
        metadata: { name: 'Tether USD', symbol: 'USDT', decimals }
      })
      const create = (entry, tokens = [token]) =>
        createBackgroundConfidentialFundingCoordinator(
          network,
          [],
          [entry],
          [],
          tokens,
          getActiveChainEndpointSettings(),
          async () => {}
        )
      const source = { chainId, assetId, protocolAssetId }
      expect(definition.verification).toBe('unverified')
      expect(create(definition).hasExternalDepositAsset(source)).toBe(true)
      expect(create(definition, []).hasExternalDepositAsset(source)).toBe(false)
      expect(
        create({ ...definition, verification: 'blocked' }).hasExternalDepositAsset(source)
      ).toBe(false)
      const conflicting = {
        ...definition,
        metadata: { ...definition.metadata, decimals: decimals + 1 }
      }
      expect(create(conflicting).hasExternalDepositAsset(source)).toBe(false)
      expect(
        create({
          ...conflicting,
          source: 'user-added',
          verification: 'user-approved'
        }).hasExternalDepositAsset(source)
      ).toBe(false)
    }
  })

  test('external ERC20 deposits bind the selected protocol representation to its chain, contract and decimals', () => {
    const contractAddress = '0x55d398326f99059ff775485246999027b3197955'
    const assetId = `eip155:56/erc20:${contractAddress}`
    const legacy = {
      assetId: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g',
      blockchain: 'bsc',
      symbol: 'USDT(DEPRECATED)',
      decimals: 18,
      contractAddress
    }
    const current = {
      ...legacy,
      assetId: `nep141:bnb-${contractAddress}.omdep.near`,
      symbol: 'USDT'
    }
    let catalog = [legacy, current]
    const coordinator = new ConfidentialFundingCoordinator({
      network: 'mainnet',
      evmNetworks: getEvmNetworkConfigs('mainnet'),
      assets: {
        get: id =>
          id === assetId ? { asset: { namespace: 'erc20' }, metadata: { decimals: 18 } } : undefined
      },
      assetMappings: [{ assetId, protocolAssetId: legacy.assetId }],
      getProtocolTokens: () => catalog
    })
    const source = { chainId: 'eip155:56', assetId, protocolAssetId: current.assetId }
    expect(coordinator.hasExternalDepositAsset(source)).toBe(true)
    for (const replacement of [
      { ...current, contractAddress: '0x1111111111111111111111111111111111111111' },
      { ...current, blockchain: 'base' },
      { ...current, decimals: 6 }
    ]) {
      catalog = [legacy, replacement]
      expect(coordinator.hasExternalDepositAsset(source)).toBe(false)
    }
    catalog = [legacy]
    expect(coordinator.hasExternalDepositAsset(source)).toBe(false)
  })

  test('registers NEAR and Solana catalog assets for external deposits', t => {
    for (const key of ['__CONFIDENTIAL_ONE_CLICK_API_URL__', '__RHEA_SWAP_ACCESS_TOKEN__']) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, key)
      Object.defineProperty(globalThis, key, { value: '', configurable: true })
      t.after(() => {
        if (previous) Object.defineProperty(globalThis, key, previous)
        else delete globalThis[key]
      })
    }
    const nearToken = {
      assetId: 'nep141:usdt.tether-token.near',
      blockchain: 'near',
      contractAddress: 'usdt.tether-token.near',
      decimals: 6,
      symbol: 'USDT',
      price: 1,
      priceUpdatedAt: '2020-01-01T00:00:00.000Z'
    }
    const solanaToken = {
      assetId: 'nep141:sol.omft.near',
      blockchain: 'sol',
      decimals: 9,
      symbol: 'SOL',
      price: 1,
      priceUpdatedAt: '2020-01-01T00:00:00.000Z'
    }
    const coordinator = createBackgroundConfidentialFundingCoordinator(
      getEvmNetworkConfigs('mainnet'),
      [],
      [],
      [],
      [nearToken, solanaToken],
      getActiveChainEndpointSettings(),
      async () => {}
    )
    expect(
      coordinator.hasExternalDepositAsset({
        chainId: 'near:mainnet',
        assetId: 'near:mainnet/nep141:usdt.tether-token.near',
        protocolAssetId: nearToken.assetId
      })
    ).toBe(true)
    expect(
      coordinator.hasExternalDepositAsset({
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        assetId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
        protocolAssetId: solanaToken.assetId
      })
    ).toBe(true)
  })

  test('external Shield deposit is account-bound, idempotent and recovers from status without local signing', async () => {
    const address = '0x1111111111111111111111111111111111111111'
    const refundAddress = '0x2222222222222222222222222222222222222222'
    const source = {
      chainId: 'eip155:8453',
      chainName: 'Base',
      assetId: 'eip155:8453/slip44:60',
      protocolAssetId: 'nep141:base.omft.near',
      amountRaw: '1000'
    }
    const records = new Map()
    const repository = new InMemoryTransactionRepository()
    let quoteCalls = 0
    let catalogBlockchain = 'base'
    let balanceReads = 0
    let simulateConcurrentBalanceReads = false
    let concurrentBalanceRead = 0
    let cachedBalance
    let signingCalls = 0
    let serviceStatus = 'PENDING_DEPOSIT'
    let settledAmountOutRaw = '987'
    let serviceErrorStatus
    let depositedAmountRaw
    let now = 1_000
    let statusCalls = 0
    let monitoringCalls = 0
    const coordinatorOptions = {
      network: 'mainnet',
      api: {
        async quote(request) {
          quoteCalls += 1
          return {
            correlationId: 'external-quote',
            quoteRequest: {
              swapType: 'EXACT_INPUT',
              confidentiality: 'basic',
              originAsset: request.originAsset,
              destinationAsset: request.destinationAsset,
              amount: request.amountRaw,
              refundTo: request.refundTo,
              depositType: request.depositType,
              refundType: request.refundType,
              recipient: request.recipient,
              recipientType: request.recipientType,
              slippageTolerance: request.slippageBps
            },
            quote: {
              amountIn: '1000',
              amountOut: '990',
              minAmountOut: '980',
              depositAddress: '0x3333333333333333333333333333333333333333',
              depositMemo: 'memo-1',
              deadline: new Date(60_000).toISOString()
            }
          }
        },
        async quoteFlexibleDeposit(request) {
          return {
            correlationId: 'flexible-external-quote',
            quoteRequest: {
              dry: false,
              swapType: 'FLEX_INPUT',
              confidentiality: 'basic',
              originAsset: request.originAsset,
              destinationAsset: request.originAsset,
              amount: '35000000000001',
              refundTo: request.refundTo,
              depositType: 'ORIGIN_CHAIN',
              refundType: 'ORIGIN_CHAIN',
              recipient: request.signerId,
              recipientType: 'CONFIDENTIAL_INTENTS',
              slippageTolerance: 0
            },
            quote: {
              amountIn: '35000000000001',
              minAmountIn: '35000000000001',
              amountOut: '35000000000001',
              minAmountOut: '35000000000001',
              depositAddress: '0x4444444444444444444444444444444444444444',
              deadline: new Date(now + 60_000).toISOString()
            }
          }
        },
        async getOneClickStatus(_address, memo) {
          statusCalls += 1
          expect(memo).toBe('memo-1')
          return {
            status: serviceStatus,
            ...(depositedAmountRaw !== undefined ? { depositedAmountRaw } : {}),
            ...(serviceStatus === 'SUCCESS' && settledAmountOutRaw !== undefined
              ? { settledAmountOutRaw }
              : {}),
            ...(serviceErrorStatus !== undefined ? { errorStatus: serviceErrorStatus } : {})
          }
        },
        async getBalances() {
          balanceReads += 1
          if (simulateConcurrentBalanceReads) {
            const read = ++concurrentBalanceRead
            await new Promise(resolve => setTimeout(resolve, read === 1 ? 15 : 0))
            return [{ tokenId: source.protocolAssetId, available: String(read), source: 'intents' }]
          }
          return []
        }
      },
      store: {
        async getExternalDeposit(id) {
          return records.get(id) ?? null
        },
        async listExternalDeposits() {
          return [...records.values()]
        },
        async listPlans() {
          return []
        },
        async putExternalDeposit(record) {
          records.set(record.depositId, structuredClone(record))
        },
        async withExternalDepositScope(_scope, operation) {
          return operation()
        },
        async getSession() {
          return { accessToken: 'synthetic', expiresAt: now + 1_000_000 }
        },
        async putBalances(_network, _domain, _account, balances) {
          cachedBalance = balances
        }
      },
      signer: {
        async resolveIdentity() {
          return {
            address,
            addressIndex: 0,
            peaAddress: refundAddress,
            context: {
              chainAccount: {
                scope: {
                  keyDomainId: 'wallet:one',
                  accountId: 'account:one',
                  chainId: 'eip155:8453'
                }
              }
            }
          }
        },
        async signMessage() {
          signingCalls += 1
          throw new Error('Unexpected signing')
        },
        async prepareTransaction() {
          signingCalls += 1
          throw new Error('Unexpected signing')
        }
      },
      repository,
      assets: { get: () => ({ asset: {}, metadata: { symbol: 'ETH', decimals: 18 } }) },
      protocolTokens: [{ assetId: source.protocolAssetId, blockchain: 'base', decimals: 18 }],
      getProtocolTokens: () => [
        { assetId: source.protocolAssetId, blockchain: catalogBlockchain, decimals: 18 }
      ],
      evmNetworks: getEvmNetworkConfigs('mainnet').filter(
        network => network.chainId === source.chainId
      ),
      assetMappings: [{ assetId: source.assetId, protocolAssetId: source.protocolAssetId }],
      now: () => now,
      createId: () => (records.has('external-one') ? 'external-two' : 'external-one'),
      scheduleMonitoring: async () => {
        monitoringCalls += 1
      }
    }
    const coordinator = new ConfidentialFundingCoordinator(coordinatorOptions)
    const request = {
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      refundAddress,
      requestId: 'create-one'
    }
    const created = await coordinator.createExternalDeposit(request)
    expect(canPayShieldDeposit(created, now)).toBe(true)
    expect(canPayShieldDeposit(created, created.expiresAt)).toBe(false)
    expect(isExternalShieldDepositPending(created, created.expiresAt)).toBe(false)
    const providerExpired = {
      ...created,
      providerStatus: 'EXPIRED',
      expiresAt: now + 3 * 24 * 60 * 60 * 1000
    }
    expect(depositStatusLabel(providerExpired, now)).toBe('Quote expired')
    expect(canPayShieldDeposit(providerExpired, now)).toBe(false)
    expect(isExternalShieldDepositPending(providerExpired, now)).toBe(false)
    expect(
      isExternalShieldDepositAutoHidden(providerExpired, created.createdAt + 24 * 60 * 60 * 1000)
    ).toBe(true)
    records.set(created.depositId, providerExpired)
    await expect(coordinator.createExternalDeposit(request)).rejects.toThrow('quote has expired')
    records.set(created.depositId, created)
    const pendingGraph = createExternalShieldDepositGraph(created)
    expect(() => assertPersistableTransactionGraph(pendingGraph)).not.toThrow()
    expect(() =>
      assertPersistableTransactionGraph({
        ...pendingGraph,
        root: {
          ...pendingGraph.root,
          intent: { ...pendingGraph.root.intent, direction: 'outgoing' }
        }
      })
    ).toThrow('signed transaction graph')
    const failedGraph = {
      root: {
        ...pendingGraph.root,
        status: 'failed',
        failure: { code: 'relay-failed', occurredAt: 2_000 }
      },
      segments: pendingGraph.segments.map(segment => ({
        ...segment,
        status: 'failed',
        failure: { code: 'relay-failed', occurredAt: 2_000 }
      }))
    }
    const refundedView = projectExternalShieldDepositActivityGraph(failedGraph, {
      ...created,
      phase: 'refunded',
      updatedAt: 3_000
    })
    expect(failedGraph.root.failure.code).toBe('relay-failed')
    expect(refundedView.root.failure.code).toBe('refunded')
    expect(refundedView.segments.every(segment => segment.failure.code === 'refunded')).toBe(true)
    expect(
      projectExternalShieldDepositActivityGraph(failedGraph, {
        ...created,
        accountId: 'other',
        phase: 'refunded'
      })
    ).toBe(failedGraph)
    expect(created.depositAddress).toBe('0x3333333333333333333333333333333333333333')
    expect(created.depositMemo).toBe('memo-1')
    records.set(created.depositId, {
      ...records.get(created.depositId),
      source: Object.fromEntries(Object.entries(source).reverse())
    })
    expect((await coordinator.createExternalDeposit(request)).depositId).toBe(created.depositId)
    catalogBlockchain = 'eth'
    await expect(
      coordinator.createExternalDeposit({
        ...request,
        requestId: 'wrong-source-network',
        source
      })
    ).rejects.toThrow('asset catalog changed')
    catalogBlockchain = 'base'
    expect(quoteCalls).toBe(1)
    await expect(
      coordinator.createExternalDeposit({ ...request, accountId: 'other' })
    ).rejects.toThrow('Account changed')
    await expect(
      coordinator.createExternalDeposit({ ...request, refundAddress: address })
    ).rejects.toThrow('request ID was reused')
    const unfunded = await coordinator.refreshExternalDeposit(created.depositId)
    const afterInitialStatus = statusCalls
    await Promise.all([
      coordinator.refreshExternalDeposit(created.depositId, false),
      coordinator.refreshExternalDeposit(created.depositId, false)
    ])
    expect(statusCalls).toBe(afterInitialStatus)
    await Promise.all([
      coordinator.refreshExternalDeposit(created.depositId, false),
      coordinator.refreshExternalDeposit(created.depositId, true),
      coordinator.refreshExternalDeposit(created.depositId, true)
    ])
    expect(statusCalls).toBe(afterInitialStatus + 1)
    now += 20_000
    await coordinator.refreshExternalDeposit(created.depositId, false)
    expect(statusCalls).toBe(afterInitialStatus + 2)
    await coordinator.refreshExternalDeposit(created.depositId)
    expect(statusCalls).toBe(afterInitialStatus + 3)
    now = unfunded.updatedAt + 3 * 60 * 60 * 1000
    expect(shouldAutoRefreshExternalShieldDeposit(unfunded, now - 1)).toBe(true)
    const beforePause = { statusCalls, monitoringCalls }
    await new ConfidentialFundingCoordinator(coordinatorOptions).resumeAll()
    expect({ statusCalls, monitoringCalls }).toEqual(beforePause)
    expect(await coordinator.getExternalDeposit(created.depositId)).toEqual(unfunded)
    expect(
      isExternalShieldDepositAutoHidden(unfunded, created.createdAt + 24 * 60 * 60 * 1000 - 1)
    ).toBe(false)
    now = created.createdAt + 24 * 60 * 60 * 1000
    expect(isExternalShieldDepositAutoHidden(unfunded, now)).toBe(true)

    // A manual refresh can discover late funding even after automatic monitoring stops.
    serviceStatus = 'INCOMPLETE_DEPOSIT'
    const fundedWithoutAmount = await coordinator.refreshExternalDeposit(created.depositId)
    expect(fundedWithoutAmount.fundingObservedAt).toBe(now)
    expect(monitoringCalls).toBeGreaterThan(beforePause.monitoringCalls)
    serviceStatus = 'EXPIRED'
    now += 24 * 60 * 60 * 1000
    await new ConfidentialFundingCoordinator(coordinatorOptions).resumeAll()
    const expiredPartial = await coordinator.getExternalDeposit(created.depositId)
    expect(expiredPartial.providerStatus).toBe('EXPIRED')
    expect(expiredPartial.fundingObservedAt).toBe(fundedWithoutAmount.fundingObservedAt)
    expect(canPayShieldDeposit(expiredPartial, now)).toBe(false)
    expect(isExternalShieldDepositPending(expiredPartial, now)).toBe(true)
    expect(isExternalShieldDepositAutoHidden(expiredPartial, now)).toBe(false)
    const beforeRecovery = statusCalls
    await new ConfidentialFundingCoordinator(coordinatorOptions).resumeAll()
    expect(statusCalls).toBe(beforeRecovery + 1)
    serviceStatus = 'INCOMPLETE_DEPOSIT'
    depositedAmountRaw = '400'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).depositedAmountRaw).toBe(
      '400'
    )
    depositedAmountRaw = '200'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).depositedAmountRaw).toBe(
      '400'
    )
    serviceStatus = 'PROCESSING'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).phase).toBe('processing')
    serviceStatus = 'INCOMPLETE_DEPOSIT'
    depositedAmountRaw = '500'
    const processingPartial = await coordinator.refreshExternalDeposit(created.depositId)
    expect(processingPartial.phase).toBe('processing')
    expect(processingPartial.depositedAmountRaw).toBe('500')
    serviceStatus = 'SUCCESS'
    depositedAmountRaw = '1000'
    expect((await coordinator.refreshExternalDeposit(created.depositId)).phase).toBe('ready')
    expect(balanceReads).toBe(1)
    const graph = await repository.get(
      { keyDomainId: 'wallet:one', accountId: 'account:one' },
      created.transactionId
    )
    expect(graph.root.status).toBe('final')
    expect(graph.root.intent.counterAmount.amountRaw).toBe('990')
    expect(graph.segments.find(segment => segment.role === 'destination').evidence).toMatchObject({
      settledAmount: { assetId: source.assetId, amountRaw: '987' }
    })
    expect((await coordinator.getExternalDeposit(created.depositId)).settledOutputRaw).toBe('987')
    expect((await coordinator.getExternalDeposit(created.depositId)).depositedAmountRaw).toBe(
      '1000'
    )
    expect((await coordinator.refreshExternalDeposit(created.depositId)).phase).toBe('ready')
    expect(balanceReads).toBe(1)
    expect(signingCalls).toBe(0)

    const underMinimum = {
      ...created,
      depositId: 'under-minimum',
      transactionId: 'tx:confidential-external:under-minimum',
      phase: 'processing'
    }
    records.set(underMinimum.depositId, underMinimum)
    await repository.create(createExternalShieldDepositGraph(underMinimum))
    settledAmountOutRaw = '979'
    const shortfall = await coordinator.refreshExternalDeposit(underMinimum.depositId)
    expect(shortfall.phase).toBe('ready')
    expect(shortfall.settledOutputRaw).toBe('979')
    expect(shortfall.errorStatus).toBe('DEPOSIT_AMOUNT_TOO_LOW')
    expect(depositStatusLabel(shortfall, now)).toBe('Received less than minimum')
    const shortfallGraph = await repository.get(
      { keyDomainId: 'wallet:one', accountId: 'account:one' },
      underMinimum.transactionId
    )
    expect(shortfallGraph.root.status).toBe('final')
    expect(
      shortfallGraph.segments.find(segment => segment.role === 'destination').evidence
    ).toMatchObject({ settledAmount: { amountRaw: '979' } })

    for (const providerWarning of [undefined, 'PROVIDER_WARNING']) {
      const depositId = providerWarning ? 'late-provider-warning' : 'late-settlement'
      const lateSettlement = {
        ...created,
        depositId,
        transactionId: `tx:confidential-external:${depositId}`,
        phase: 'processing'
      }
      records.set(depositId, lateSettlement)
      await repository.create(createExternalShieldDepositGraph(lateSettlement))
      settledAmountOutRaw = undefined
      serviceErrorStatus = providerWarning
      const awaitingAmount = await coordinator.refreshExternalDeposit(depositId)
      expect(awaitingAmount.phase).toBe('ready')
      expect(awaitingAmount.settledOutputRaw).toBeUndefined()
      expect(awaitingAmount.errorStatus).toBe(providerWarning)
      expect(depositStatusLabel(awaitingAmount, now)).toBe('Received')
      settledAmountOutRaw = '979'
      serviceErrorStatus = undefined
      const lateShortfall = await coordinator.refreshExternalDeposit(depositId)
      expect(lateShortfall.phase).toBe('ready')
      expect(lateShortfall.settledOutputRaw).toBe('979')
      expect(lateShortfall.errorStatus).toBe(providerWarning ?? 'DEPOSIT_AMOUNT_TOO_LOW')
      expect(depositStatusLabel(lateShortfall, now)).toBe('Received less than minimum')
      serviceStatus = 'REFUNDED'
      const afterStaleStatus = await coordinator.refreshExternalDeposit(depositId)
      expect(afterStaleStatus.phase).toBe('ready')
      expect(afterStaleStatus.settledOutputRaw).toBe('979')
      expect(afterStaleStatus.errorStatus).toBe(lateShortfall.errorStatus)
      serviceStatus = 'SUCCESS'
    }
    settledAmountOutRaw = '987'

    for (const [depositId, phase] of [
      ['refund-recovery', 'refunded'],
      ['failure-recovery', 'failed'],
      ['ready-recovery', 'ready']
    ]) {
      const interrupted = {
        ...created,
        depositId,
        transactionId: `tx:confidential-external:${depositId}`,
        phase,
        ...(phase === 'ready' ? { settledOutputRaw: '987', balanceRefreshedAt: 1_000 } : {})
      }
      records.set(depositId, interrupted)
      await repository.create(createExternalShieldDepositGraph(interrupted))
    }
    await coordinator.resumeAll()
    for (const [depositId, expectedStatus] of [
      ['refund-recovery', 'failed'],
      ['failure-recovery', 'failed'],
      ['ready-recovery', 'final']
    ]) {
      const recovered = await repository.get(
        { keyDomainId: 'wallet:one', accountId: 'account:one' },
        `tx:confidential-external:${depositId}`
      )
      expect(recovered.root.status).toBe(expectedStatus)
    }
    const refundGraph = await repository.get(
      { keyDomainId: 'wallet:one', accountId: 'account:one' },
      'tx:confidential-external:refund-recovery'
    )
    expect(refundGraph.root.failure.code).toBe('refunded')
    const readyGraph = await repository.get(
      { keyDomainId: 'wallet:one', accountId: 'account:one' },
      'tx:confidential-external:ready-recovery'
    )
    expect(
      readyGraph.segments.find(segment => segment.role === 'destination').evidence
    ).toMatchObject({
      settledAmount: { amountRaw: '987' }
    })
    for (const depositId of ['balance-recovery-one', 'balance-recovery-two']) {
      const pendingBalance = {
        ...created,
        depositId,
        transactionId: `tx:confidential-external:${depositId}`,
        phase: 'ready',
        settledOutputRaw: '987'
      }
      records.set(depositId, pendingBalance)
      await repository.create(createExternalShieldDepositGraph(pendingBalance))
    }
    simulateConcurrentBalanceReads = true
    await Promise.all([
      coordinator.refreshExternalDeposit('balance-recovery-one'),
      coordinator.refreshExternalDeposit('balance-recovery-two')
    ])
    expect(cachedBalance).toEqual([
      { tokenId: source.protocolAssetId, available: '2', source: 'intents' }
    ])
    const { amountRaw: _amountRaw, ...sourceWithoutAmount } = source
    const minimumRequest = { ...request, requestId: 'minimum-one', source: sourceWithoutAmount }
    const minimumDeposit = await coordinator.createExternalDeposit(minimumRequest)
    expect(minimumDeposit).toMatchObject({
      amountMode: 'minimum',
      amountRaw: '35000000000001',
      source: { amountRaw: '35000000000001' },
      slippageBps: 0
    })
    expect((await coordinator.createExternalDeposit(minimumRequest)).depositId).toBe(
      minimumDeposit.depositId
    )
    await expect(coordinator.createExternalDeposit({ ...minimumRequest, source })).rejects.toThrow(
      'request ID was reused'
    )
  })

  test('discovers the provider minimum and binds a flexible external deposit quote', async () => {
    const originalFetch = globalThis.fetch
    const requests = []
    const signerId = '0x1111111111111111111111111111111111111111'
    const refundTo = '0x2222222222222222222222222222222222222222'
    const asset = 'nep141:eth.omft.near'
    let tamper = false
    let drySucceeds = false
    let finalMinimumTooHigh = false
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      if (request.dry && !drySucceeds) {
        return new Response(
          JSON.stringify({ message: 'Amount is too low for bridge, try at least 35000000000001' }),
          { status: 400 }
        )
      }
      return new Response(
        JSON.stringify({
          correlationId: 'flex-quote',
          quoteRequest: { ...request, recipient: tamper ? refundTo : request.recipient },
          quote: {
            amountIn: request.amount,
            minAmountIn: request.dry
              ? '35000000000001'
              : finalMinimumTooHigh
                ? '35000000000002'
                : request.amount,
            amountOut: request.amount,
            minAmountOut: request.amount,
            depositAddress: '0x3333333333333333333333333333333333333333',
            deadline: new Date(Date.now() + 60_000).toISOString()
          }
        }),
        { status: 201 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', '')
      const input = { originAsset: asset, signerId, refundTo }
      const quote = await api.quoteFlexibleDeposit(input)
      expect(requests.map(request => [request.dry, request.amount, request.swapType])).toEqual([
        [true, '1', 'FLEX_INPUT'],
        [false, '35000000000001', 'FLEX_INPUT']
      ])
      expect(requests.every(request => request.slippageTolerance === 0)).toBe(true)
      expect(requests.every(request => request.referral === 'noir_receive')).toBe(true)
      expect(quote.quote.minAmountIn).toBe('35000000000001')
      tamper = true
      await expect(api.quoteFlexibleDeposit(input)).rejects.toThrow(
        'Flexible external Shield quote does not match'
      )
      tamper = false
      drySucceeds = true
      const discovered = await api.quoteFlexibleDeposit(input)
      expect(requests.slice(-2).map(request => [request.dry, request.amount])).toEqual([
        [true, '1'],
        [false, '35000000000001']
      ])
      expect(discovered.quote.minAmountIn).toBe('35000000000001')
      finalMinimumTooHigh = true
      await expect(api.quoteFlexibleDeposit(input)).rejects.toThrow(
        'Flexible external Shield quote does not match'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
  test('does not turn a malformed balance response into a confirmed zero', async () => {
    const originalFetch = globalThis.fetch
    const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', '')
    let request
    globalThis.fetch = async (url, init) => {
      request = { url, init }
      return new Response(
        JSON.stringify({
          balances: [{ tokenId: 'nep141:eth.omft.near', available: 'unknown' }]
        }),
        { status: 200 }
      )
    }
    try {
      await expect(api.getBalances('session')).rejects.toThrow('balance row is invalid')
      expect(request.url).toBe('https://direct.example.test/v0/account/balances')
      expect(request.init.headers.Authorization).toBe('Bearer session')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps the destination hash from a pending RHEA order status', async () => {
    const originalFetch = globalThis.fetch
    const hash = `0x${'cd'.repeat(32)}`
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 0, data: { status: 'PROCESSING', toHash: hash } }), {
        status: 200
      })
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'test-token')
      await expect(api.getStatus('deposit-address', '1')).resolves.toMatchObject({
        status: 'PROCESSING',
        transactionHash: hash
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('binds an exact-output quote to its target, sender refund, and recipient', async () => {
    const originalFetch = globalThis.fetch
    const sender = '0x1111111111111111111111111111111111111111'
    const recipient = '0x2222222222222222222222222222222222222222'
    const asset = 'nep141:base-0x3333333333333333333333333333333333333333.omft.near'
    const depositAddress = '0x4444444444444444444444444444444444444444'
    const destinationHash = `0x${'ab'.repeat(32)}`
    const inactiveAt = new Date(Date.now() + 30_000).toISOString()
    let changeRecipient = false
    globalThis.fetch = async (url, init) => {
      if (url === `https://example.test/1click/status?depositAddress=${depositAddress}`) {
        return new Response(
          JSON.stringify({
            status: 'SUCCESS',
            quoteResponse: { quote: { depositAddress } },
            swapDetails: {
              amountOut: '1000',
              destinationChainTxHashes: [{ hash: destinationHash }]
            }
          }),
          { status: 200 }
        )
      }
      if (url === 'https://example.test/api/swap/confidential-app-fee') {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              appId: 'ak_test',
              confidentialAppFeeBps: 0,
              confidentialAppFeeRecipient: '',
              confidentialPlatformFeeBps: 0,
              confidentialPlatformFeeRecipient: ''
            }
          }),
          { status: 200 }
        )
      }
      expect(url).toBe('https://example.test/1click/quote')
      const request = JSON.parse(init.body)
      expect(request).toMatchObject({
        swapType: 'EXACT_OUTPUT',
        referral: 'noir_send',
        depositType: 'ORIGIN_CHAIN',
        recipientType: 'DESTINATION_CHAIN',
        confidentiality: 'basic',
        amount: '1000',
        refundTo: sender
      })
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            correlationId: 'exact-one',
            quoteRequest: {
              ...request,
              ...(changeRecipient && !request.dry ? { recipient: sender } : {})
            },
            quote: {
              amountIn: '1020',
              minAmountIn: '1010',
              amountOut: '1000',
              minAmountOut: '1000',
              depositAddress: request.dry ? undefined : depositAddress,
              timeWhenInactive: inactiveAt,
              deadline: request.deadline
            }
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'test-token')
      const input = { asset, amountOutRaw: '1000', sender, recipient, slippageBps: 100 }
      await expect(api.quoteExactOutput(input)).resolves.toMatchObject({
        minimumInputRaw: '1010',
        expiresAt: Date.parse(inactiveAt),
        quote: { amountIn: '1020', amountOut: '1000', minAmountOut: '1000' }
      })
      await expect(api.getOneClickStatus(depositAddress)).resolves.toMatchObject({
        status: 'SUCCESS',
        settledAmountOutRaw: '1000',
        transactionHash: destinationHash
      })
      changeRecipient = true
      await expect(api.quoteExactOutput(input)).rejects.toThrow(/does not match/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('accepts a pending internal swap status and rejects a mismatched echoed quote', async () => {
    const originalFetch = globalThis.fetch
    let echoedAddress = 'deposit-one'
    let echoedMemo
    globalThis.fetch = async url => {
      expect(url).toBe(
        `https://example.test/1click/status?depositAddress=deposit-one${echoedMemo ? '&depositMemo=+memo-1+' : ''}`
      )
      return new Response(
        JSON.stringify({
          status: 'PENDING_DEPOSIT',
          quoteResponse: {
            quote: {
              depositAddress: echoedAddress,
              ...(echoedMemo ? { depositMemo: echoedMemo } : {})
            }
          },
          swapDetails: { depositedAmount: '400' }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', '')
      await expect(api.getOneClickStatus('deposit-one')).resolves.toMatchObject({
        status: 'PENDING_DEPOSIT',
        depositedAmountRaw: '400'
      })
      echoedMemo = ' memo-1 '
      await expect(api.getOneClickStatus('deposit-one', ' memo-1 ')).resolves.toMatchObject({
        status: 'PENDING_DEPOSIT'
      })
      echoedMemo = 'different'
      await expect(api.getOneClickStatus('deposit-one', ' memo-1 ')).rejects.toThrow(
        'memo does not match'
      )
      echoedMemo = undefined
      echoedAddress = 'deposit-other'
      await expect(api.getOneClickStatus('deposit-one')).rejects.toThrow('does not match')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('binds confidential quote fees to the current application config', async () => {
    const originalFetch = globalThis.fetch
    let feeConfig = {
      appId: 'ak_test',
      confidentialAppFeeBps: 0,
      confidentialAppFeeRecipient: '',
      confidentialPlatformFeeBps: 50,
      confidentialPlatformFeeRecipient: 'platform.near'
    }
    let echoedFees
    const quoteRequests = []
    let feeReads = 0
    let providerFee = { recipient: 'provider.near', fee: 20 }
    globalThis.fetch = async (url, init) => {
      if (url === 'https://example.test/api/swap/confidential-app-fee') {
        feeReads += 1
        expect(init.headers.Authorization).toBe('Bearer swap-jwt')
        return new Response(JSON.stringify({ code: 0, data: feeConfig }), { status: 200 })
      }
      expect(url).toBe('https://example.test/1click/quote')
      const requestBody = JSON.parse(init.body)
      quoteRequests.push(requestBody)
      const responseFees =
        requestBody.depositType === 'CONFIDENTIAL_INTENTS'
          ? requestBody.appFees
            ? (echoedFees ?? [...requestBody.appFees, ...(providerFee ? [providerFee] : [])])
            : providerFee
              ? [providerFee]
              : []
          : undefined
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            correlationId: 'quote-1',
            quoteRequest: {
              ...requestBody,
              ...(responseFees !== undefined ? { appFees: responseFees } : {})
            },
            quote: {
              amountIn: '1000',
              amountOut: '900',
              deadline: new Date(Date.now() + 60_000).toISOString()
            }
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      const withdrawal = {
        referral: 'noir_send',
        originAsset: 'nep141:eth.omft.near',
        destinationAsset: 'nep141:usdc.omft.near',
        amountRaw: '1000',
        signerId: '0x1111111111111111111111111111111111111111',
        recipient: '0x2222222222222222222222222222222222222222',
        depositType: 'CONFIDENTIAL_INTENTS',
        refundType: 'CONFIDENTIAL_INTENTS',
        recipientType: 'DESTINATION_CHAIN',
        slippageBps: 50,
        dry: false
      }
      const quotedWithdrawal = await api.quote(withdrawal)
      expect(quoteRequests[0].dry).toBe(true)
      expect(quoteRequests[0].appFees).toBeUndefined()
      expect(quoteRequests[0].referral).toBe('noir_send')
      expect(quoteRequests[1].referral).toBe('noir_send')
      expect(quoteRequests[1].appFees).toEqual([{ recipient: 'platform.near', fee: 50 }])
      expect(quotedWithdrawal.quoteRequest.appFees).toEqual([
        { recipient: 'platform.near', fee: 50 },
        providerFee
      ])
      expect(feeReads).toBe(1)
      await api.quote({
        ...withdrawal,
        referral: 'noir_move',
        depositType: 'ORIGIN_CHAIN',
        recipientType: 'CONFIDENTIAL_INTENTS'
      })
      expect(quoteRequests[2].appFees).toBeUndefined()
      expect(quoteRequests[2].referral).toBe('noir_move')
      expect(feeReads).toBe(1)
      await api.quote({
        ...withdrawal,
        referral: 'noir_swap',
        recipient: withdrawal.signerId,
        recipientType: 'CONFIDENTIAL_INTENTS',
        dry: true
      })
      expect(quoteRequests[4]).toMatchObject({
        referral: 'noir_swap',
        swapType: 'EXACT_INPUT',
        depositType: 'CONFIDENTIAL_INTENTS',
        recipientType: 'CONFIDENTIAL_INTENTS',
        refundType: 'CONFIDENTIAL_INTENTS',
        recipient: withdrawal.signerId,
        refundTo: withdrawal.signerId,
        appFees: [{ recipient: 'platform.near', fee: 50 }]
      })
      const concurrentApi = new ConfidentialFundingApi(
        apiConfig,
        'https://near.example.test',
        'swap-jwt'
      )
      await Promise.all([concurrentApi.quote(withdrawal), concurrentApi.quote(withdrawal)])
      expect(feeReads).toBe(2)
      echoedFees = [{ recipient: 'platform.near', fee: 2 }]
      await expect(api.quote(withdrawal)).rejects.toThrow('app fees do not match')
      echoedFees = [
        { recipient: 'platform.near', fee: 50 },
        { ...providerFee, recipient: 'other.near' }
      ]
      await expect(api.quote(withdrawal)).rejects.toThrow('app fees do not match')
      echoedFees = undefined
      providerFee = undefined
      const partnerQuote = await api.quote(withdrawal)
      expect(partnerQuote.quoteRequest.appFees).toEqual([{ recipient: 'platform.near', fee: 50 }])
      providerFee = { recipient: 'provider.near', fee: 1 }
      const lowFeeQuote = await api.quote(withdrawal)
      expect(lowFeeQuote.quoteRequest.appFees).toEqual([
        { recipient: 'platform.near', fee: 50 },
        providerFee
      ])
      echoedFees = [
        { recipient: 'platform.near', fee: 50 },
        { recipient: 'provider.near', fee: 2 }
      ]
      await expect(api.quote(withdrawal)).rejects.toThrow('app fees do not match')
      echoedFees = undefined
      providerFee = { recipient: 'provider.near', fee: 21 }
      await expect(api.quote(withdrawal)).rejects.toThrow('provider fee quote is invalid')
      feeConfig = { ...feeConfig, confidentialPlatformFeeBps: 10_001 }
      await expect(
        new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt').quote(
          withdrawal
        )
      ).rejects.toThrow('fee rate is invalid')
      expect(quoteRequests).toHaveLength(20)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('quotes a Solana confidential account as the hex public key', async () => {
    const solanaAccount = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
    const privateAccount = 'SysvarRent111111111111111111111111111111111'
    const intentsAccountId = confidentialIntentsAccountId(solanaAccount)
    expect(intentsAccountId).toMatch(/^[0-9a-f]{64}$/)
    expect(confidentialIntentsAccountId('11111111111111111111111111111111')).toBe('0'.repeat(64))
    expect(confidentialIntentsAccountId(intentsAccountId)).toBe(intentsAccountId)
    const originalFetch = globalThis.fetch
    const requests = []
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/api/swap/confidential-app-fee')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              appId: 'ak_test',
              confidentialAppFeeBps: 0,
              confidentialAppFeeRecipient: '',
              confidentialPlatformFeeBps: 0,
              confidentialPlatformFeeRecipient: ''
            }
          }),
          { status: 200 }
        )
      }
      const request = JSON.parse(init.body)
      requests.push(request)
      return new Response(
        JSON.stringify({
          correlationId: 'solana-quote',
          quoteRequest: request,
          quote: {
            amountIn: request.amount,
            amountOut: request.amount,
            minAmountOut: request.amount,
            depositAddress: privateAccount,
            deadline: new Date(Date.now() + 60_000).toISOString()
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      await api.quote({
        referral: 'noir_move',
        originAsset: 'nep141:sol.omft.near',
        destinationAsset: 'nep141:sol.omft.near',
        amountRaw: '5000000',
        signerId: solanaAccount,
        refundTo: solanaAccount,
        recipient: solanaAccount,
        depositType: 'ORIGIN_CHAIN',
        refundType: 'ORIGIN_CHAIN',
        recipientType: 'CONFIDENTIAL_INTENTS',
        slippageBps: 50,
        dry: true
      })
      expect(requests[0]).toMatchObject({
        recipient: intentsAccountId,
        refundTo: solanaAccount,
        recipientType: 'CONFIDENTIAL_INTENTS',
        refundType: 'ORIGIN_CHAIN'
      })
      await api.quote({
        referral: 'noir_move',
        originAsset: 'nep141:sol.omft.near',
        destinationAsset: 'nep141:sol.omft.near',
        amountRaw: '5000000',
        signerId: solanaAccount,
        recipient: privateAccount,
        depositType: 'CONFIDENTIAL_INTENTS',
        refundType: 'CONFIDENTIAL_INTENTS',
        recipientType: 'DESTINATION_CHAIN',
        slippageBps: 50,
        dry: true
      })
      const withdraw = requests.find(
        request => request.recipientType === 'DESTINATION_CHAIN' && request.dry === true
      )
      expect(withdraw).toMatchObject({
        recipient: privateAccount,
        refundTo: intentsAccountId,
        recipientType: 'DESTINATION_CHAIN',
        refundType: 'CONFIDENTIAL_INTENTS'
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('splits two or three withdraws within bounds without losing raw units', () => {
    for (const count of [2, 3]) {
      const shares = splitConfidentialFundingAmount('1000000', count, [0, 0.5, 1])
      const equalShare = 1000000n / BigInt(count)
      expect(shares).toHaveLength(count)
      expect(shares.reduce((sum, value) => sum + BigInt(value), 0n)).toBe(1000000n)
      for (const value of shares) {
        expect(BigInt(value)).toBeGreaterThanOrEqual((equalShare * 80n) / 100n)
        expect(BigInt(value)).toBeLessThanOrEqual((equalShare * 120n) / 100n + 1n)
      }
    }
    expect(() => splitConfidentialFundingAmount('1', 2)).toThrow('too small')
    expect(() => splitConfidentialFundingAmount('100', 1)).toThrow('two to five')
  })

  test('does not finalize a mixed batch before every child reaches a terminal state', () => {
    expect(aggregateConfidentialSettlement(['SUCCESS', 'PROCESSING', 'FAILED'])).toBe('confirming')
    expect(aggregateConfidentialSettlement(['SUCCESS', 'REFUNDED', 'FAILED'])).toBe('partial')
    expect(aggregateConfidentialSettlement(['SUCCESS', 'COMPLETED'])).toBe('success')
    expect(aggregateConfidentialSettlement(['REFUNDED', 'REFUNDED'])).toBe('refunded')
    expect(aggregateConfidentialSettlement(['EXPIRED', 'CANCELLED'])).toBe('expired')
  })

  test('keeps child terminal states and evidence stable across stale and conflicting polls', () => {
    for (const status of ['SUCCESS', 'COMPLETED', 'REFUNDED', 'FAILED', 'EXPIRED', 'CANCELLED']) {
      const row = { status, transactionHash: 'original-hash', errorStatus: 'original-reason' }
      expect(mergeConfidentialWithdrawObservation(row, null)).toBe(row)
      expect(
        mergeConfidentialWithdrawObservation(row, {
          status: 'PROCESSING',
          transactionHash: 'stale-hash',
          errorStatus: 'stale-reason'
        })
      ).toBe(row)
      expect(
        mergeConfidentialWithdrawObservation(row, {
          status: ['SUCCESS', 'COMPLETED'].includes(status) ? 'REFUNDED' : 'SUCCESS'
        })
      ).toBe(row)
      expect(
        mergeConfidentialWithdrawObservation(row, {
          status,
          transactionHash: 'replacement-hash',
          errorStatus: 'replacement-reason'
        })
      ).toEqual(row)
    }
    expect(
      mergeConfidentialWithdrawObservation(
        { status: 'SUCCESS' },
        {
          status: 'COMPLETED',
          transactionHash: 'destination-hash'
        }
      )
    ).toEqual({ status: 'SUCCESS', transactionHash: 'destination-hash' })
    expect(
      mergeConfidentialWithdrawObservation(
        { status: 'PROCESSING' },
        {
          status: 'SUCCESS',
          transactionHash: 'destination-hash'
        }
      )
    ).toEqual({ status: 'SUCCESS', transactionHash: 'destination-hash' })
  })

  test('records a later refund without treating its hash as destination evidence', () => {
    for (const status of ['FAILED', 'EXPIRED', 'CANCELLED']) {
      const refunded = mergeConfidentialWithdrawObservation(
        { status, errorStatus: 'original-reason' },
        {
          status: 'REFUNDED',
          transactionHash: 'not-destination-hash'
        }
      )
      expect(refunded).toEqual({
        status: 'REFUNDED',
        errorStatus: 'original-reason'
      })
      expect(mergeConfidentialWithdrawObservation(refunded, { status: 'PROCESSING' })).toBe(
        refunded
      )
      expect(mergeConfidentialWithdrawObservation(refunded, { status: 'SUCCESS' })).toBe(refunded)
    }
    expect(
      mergeConfidentialWithdrawObservation(
        { status: 'PROCESSING' },
        { status: 'REFUNDED', transactionHash: 'not-destination-hash' }
      )
    ).toEqual({ status: 'REFUNDED' })
    expect(aggregateConfidentialSettlement(['REFUNDED', 'REFUNDED'])).toBe('refunded')
  })

  test('refuses to sign when the generated intent or quote no longer matches the frozen plan', () => {
    const deadline = new Date(Date.now() + 60_000).toISOString()
    const quote = {
      correlationId: 'quote-1',
      quoteRequest: {
        swapType: 'EXACT_INPUT',
        confidentiality: 'basic',
        originAsset: 'nep141:eth.omft.near',
        destinationAsset: 'nep141:usdc.omft.near',
        amount: '1000',
        refundTo: '0x1111111111111111111111111111111111111111',
        depositType: 'CONFIDENTIAL_INTENTS',
        refundType: 'CONFIDENTIAL_INTENTS',
        recipientType: 'DESTINATION_CHAIN',
        slippageTolerance: 100,
        recipient: '0x2222222222222222222222222222222222222222'
      },
      quote: {
        amountIn: '1000',
        amountOut: '990',
        minAmountOut: '980',
        depositAddress: 'deposit.near',
        deadline
      }
    }
    const input = {
      intent: {
        standard: 'erc191',
        payload: JSON.stringify({
          signer_id: '0x1111111111111111111111111111111111111111',
          receiver_id: 'deposit.near',
          deadline
        })
      },
      quote,
      signerId: '0x1111111111111111111111111111111111111111',
      sourceAsset: 'nep141:eth.omft.near',
      sourceAmountRaw: '1000',
      destinationAsset: 'nep141:usdc.omft.near',
      destinationAddress: '0x2222222222222222222222222222222222222222'
    }
    const quoteBinding = {
      originAsset: input.sourceAsset,
      destinationAsset: input.destinationAsset,
      amountRaw: input.sourceAmountRaw,
      signerId: input.signerId,
      recipient: input.destinationAddress,
      depositType: 'CONFIDENTIAL_INTENTS',
      refundType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'DESTINATION_CHAIN',
      slippageBps: 100
    }
    expect(() => assertConfidentialQuoteBinding(quote, quoteBinding)).not.toThrow()
    expect(() =>
      assertConfidentialQuoteBinding(quote, { ...quoteBinding, amountRaw: '1001' })
    ).toThrow('requested funding route')
    expect(assertConfidentialIntentBinding(input).standard).toBe('erc191')
    expect(() =>
      assertConfidentialIntentBinding({
        ...input,
        signerId: '0x3333333333333333333333333333333333333333'
      })
    ).toThrow('approved signer')
    expect(() => assertConfidentialIntentBinding({ ...input, sourceAmountRaw: '1001' })).toThrow(
      'approved funding plan'
    )
  })

  test('binds the only Shield withdraw action to the approved receiver, asset, and amount', () => {
    const deadline = new Date(Date.now() + 60_000).toISOString()
    const sourceAsset = 'nep141:eth.omft.near'
    const destinationAsset = 'nep141:usdc.omft.near'
    const signerId = '0x1111111111111111111111111111111111111111'
    const destinationAddress = '0x2222222222222222222222222222222222222222'
    const quote = {
      quoteRequest: { originAsset: sourceAsset, destinationAsset, recipient: destinationAddress },
      quote: { amountIn: '1000', depositAddress: 'deposit.near', deadline }
    }
    const payload = {
      verifying_contract: 'intents.far',
      signer_id: signerId,
      deadline,
      nonce: btoa(String.fromCharCode(...new Uint8Array(32))),
      intents: [
        {
          intent: 'transfer',
          receiver_id: 'deposit.near',
          tokens: { [confidentialPrivateTokenId(sourceAsset)]: '1000' }
        }
      ]
    }
    const check = changed =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent: { standard: 'erc191', payload: JSON.stringify(changed) },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    expect(check(payload).standard).toBe('erc191')
    const nep413 = assertDirectConfidentialWithdrawIntentBinding({
      intent: {
        standard: 'nep413',
        payload: {
          message: JSON.stringify(payload),
          recipient: 'intents.near',
          nonce: payload.nonce
        }
      },
      quote,
      signerId,
      sourceAsset,
      sourceAmountRaw: '1000',
      destinationAsset,
      destinationAddress
    })
    expect(nep413.standard).toBe('nep413')
    expect(JSON.parse(nep413.payload).message).toBe(JSON.stringify(payload))
    expect(
      assertDirectConfidentialWithdrawIntentBinding({
        intent: { standard: 'raw_ed25519', payload: JSON.stringify(payload) },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      }).standard
    ).toBe('raw_ed25519')
    const action = payload.intents[0]
    for (const changed of [
      { ...payload, verifying_contract: 'intents.near' },
      { ...payload, signer_id: destinationAddress },
      { ...payload, intents: [...payload.intents, action] },
      { ...payload, intents: [{ ...action, receiver_id: destinationAddress }] },
      {
        ...payload,
        intents: [{ ...action, tokens: { [confidentialPrivateTokenId(sourceAsset)]: '1001' } }]
      },
      {
        ...payload,
        intents: [{ ...action, tokens: { [confidentialPrivateTokenId(destinationAsset)]: '1000' } }]
      },
      { ...payload, intents: [{ ...action, tokens: { ...action.tokens, extra: '1' } }] },
      { ...payload, intents: [{ ...action, extra: 'value' }] }
    ])
      expect(() => check(changed)).toThrow('Shield withdraw intent')
  })

  test('binds a 1Click message that keeps its nonce on the NEP-413 envelope', () => {
    const instant = Math.floor((Date.now() + 60_000) / 1000) * 1000
    const quoteDeadline = new Date(instant).toISOString()
    const messageDeadline = quoteDeadline.replace('.000Z', 'Z')
    const sourceAsset = 'nep141:wrap.near'
    const destinationAsset = 'nep141:wrap.near'
    const signerId = '90b10ce55cb9e2661d50ffcaf6345473401155f9fb5bda4394dd00f712084f9b'
    const destinationAddress = '332366a1a19ec2ef8299f041bd19197dc674a13de4f54e26f1910e05b9c7d1cbb49cc7'
    const depositAddress = 'a1a19ec2ef8299f041bd19197dc674a13de4f54e26f1910e05b9c7d1cbb49cc7'
    const quote = {
      quoteRequest: { originAsset: sourceAsset, destinationAsset, recipient: destinationAddress },
      quote: { amountIn: '1000', depositAddress, deadline: quoteDeadline }
    }
    const message = JSON.stringify({
      deadline: messageDeadline,
      intents: [
        {
          intent: 'transfer',
          receiver_id: depositAddress,
          tokens: { [confidentialPrivateTokenId(sourceAsset)]: '1000' }
        }
      ],
      signer_id: signerId
    })
    const nonce = btoa(String.fromCharCode(...new Uint8Array(32).map((_, index) => index + 1)))
    const bind = standard =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent:
          standard === 'nep413'
            ? {
                standard,
                payload: { message, recipient: 'intents.far', nonce }
              }
            : { standard, payload: message },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    for (const standard of ['nep413', 'raw_ed25519', 'erc191']) {
      const bound = bind(standard)
      expect(bound.standard).toBe(standard)
      expect(JSON.parse(bound.payload).message ?? bound.payload).toBe(message)
    }
    expect(() =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent: {
          standard: 'nep413',
          payload: {
            message: JSON.stringify({ ...JSON.parse(message), extra: 'value' }),
            recipient: 'intents.far',
            nonce
          }
        },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    ).toThrow('Shield withdraw intent')
    expect(() =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent: {
          standard: 'nep413',
          payload: { message, recipient: 'intents.near', nonce }
        },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    ).toThrow('Shield withdraw intent verifying_contract is invalid')
  })

  test('accepts a 32-byte NEP-413 nonce array as the same base64 envelope', () => {
    const deadline = new Date(Date.now() + 60_000).toISOString()
    const sourceAsset = 'nep141:eth.omft.near'
    const destinationAsset = 'nep141:usdc.omft.near'
    const signerId = '0x1111111111111111111111111111111111111111'
    const destinationAddress = '0x2222222222222222222222222222222222222222'
    const quote = {
      quoteRequest: { originAsset: sourceAsset, destinationAsset, recipient: destinationAddress },
      quote: { amountIn: '1000', depositAddress: 'deposit.near', deadline }
    }
    const message = JSON.stringify({
      verifying_contract: 'intents.far',
      signer_id: signerId,
      deadline,
      nonce: btoa(String.fromCharCode(...new Uint8Array(32))),
      intents: [
        {
          intent: 'transfer',
          receiver_id: 'deposit.near',
          tokens: { [confidentialPrivateTokenId(sourceAsset)]: '1000' }
        }
      ]
    })
    const nonceBytes = Array.from({ length: 32 }, (_, index) => index + 1)
    const envelopeNonce = btoa(String.fromCharCode(...nonceBytes))
    const bind = nonce =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent: {
          standard: 'nep413',
          payload: { message, recipient: 'intents.near', nonce }
        },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    expect(bind(nonceBytes)).toEqual(bind(envelopeNonce))
    expect(JSON.parse(bind(nonceBytes).payload)).toEqual({
      message,
      recipient: 'intents.near',
      nonce: envelopeNonce
    })
    expect(() =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent: {
          standard: 'nep413',
          payload: {
            message: { signer_id: signerId },
            recipient: 'intents.near',
            nonce: envelopeNonce
          }
        },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    ).toThrow('Shield withdraw intent payload message is invalid')
    const farRecipient = assertDirectConfidentialWithdrawIntentBinding({
      intent: {
        standard: 'nep413',
        payload: { message, recipient: 'intents.far', nonce: envelopeNonce }
      },
      quote,
      signerId,
      sourceAsset,
      sourceAmountRaw: '1000',
      destinationAsset,
      destinationAddress
    })
    expect(JSON.parse(farRecipient.payload).recipient).toBe('intents.far')
    const derivedRecipient = assertDirectConfidentialWithdrawIntentBinding({
      intent: {
        standard: 'nep413',
        payload: { message, nonce: envelopeNonce }
      },
      quote,
      signerId,
      sourceAsset,
      sourceAmountRaw: '1000',
      destinationAsset,
      destinationAddress
    })
    expect(JSON.parse(derivedRecipient.payload).recipient).toBe('intents.far')
    expect(() =>
      assertDirectConfidentialWithdrawIntentBinding({
        intent: {
          standard: 'nep413',
          payload: { message, recipient: 'other.near', nonce: envelopeNonce }
        },
        quote,
        signerId,
        sourceAsset,
        sourceAmountRaw: '1000',
        destinationAsset,
        destinationAddress
      })
    ).toThrow('Shield withdraw intent payload recipient is invalid')
  })

  test('fingerprints the exact frozen request so a re-quote cannot be replayed as the same batch', async () => {
    const request = {
      signer_id: '0x1111111111111111111111111111111111111111',
      withdraws: [{ sequence: 0, amount: '100', deposit_address: 'deposit-a' }]
    }
    const original = await fingerprintConfidentialValue(request)
    expect(await fingerprintConfidentialValue(request)).toBe(original)
    expect(
      await fingerprintConfidentialValue({
        ...request,
        withdraws: [{ sequence: 0, amount: '100', deposit_address: 'deposit-b' }]
      })
    ).not.toBe(original)
  })

  test('submits signed single and Cluster withdrawals with Swap authorization', async () => {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ code: 0, data: { order_id: 'order-1' } }), {
        status: 200
      })
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      const row = sequence => ({
        amount: '10',
        deposit_address: `deposit-${sequence}`,
        destination_address: '0x2222222222222222222222222222222222222222',
        destination_chain: 'eth',
        execution_type: 'CONFIDENTIAL_1CLICK',
        sequence,
        signed_payload: { standard: 'erc191', payload: '{}', signature: 'secp256k1:signature' },
        token: 'nep141:eth.omft.near'
      })
      await expect(
        api.submitWithdraws({
          from_amount: '20',
          from_chain: 'eth',
          from_token: 'nep141:eth.omft.near',
          mode: 'TRANSFER',
          signer_id: '0x1111111111111111111111111111111111111111',
          withdraws: [row(0), row(1)]
        })
      ).resolves.toEqual({ orderId: 'order-1' })
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://example.test/v3/private/withdraws')
      expect(calls[0].init.headers.Authorization).toBe('Bearer swap-jwt')
      expect(JSON.parse(calls[0].init.body)).toMatchObject({
        signer_chain_family: 'evm',
        withdraws: [{ sequence: 0 }, { sequence: 1 }]
      })
      await expect(
        api.submitWithdraws({
          from_amount: '10',
          from_chain: 'eth',
          from_token: 'nep141:eth.omft.near',
          mode: 'SWAP',
          signer_id: '0x1111111111111111111111111111111111111111',
          withdraws: [row(0)]
        })
      ).resolves.toEqual({ orderId: 'order-1' })
      expect(calls).toHaveLength(2)
      expect(JSON.parse(calls[1].init.body)).toMatchObject({
        mode: 'SWAP',
        signer_chain_family: 'evm',
        withdraws: [{ sequence: 0 }]
      })
      await api.submitWithdraws(
        {
          from_amount: '10',
          from_chain: 'near',
          from_token: 'nep141:wrap.near',
          mode: 'TRANSFER',
          signer_id: 'alice.near',
          withdraws: [row(0)]
        },
        'near'
      )
      expect(JSON.parse(calls[2].init.body).signer_chain_family).toBe('near')
      await api.submitWithdraws(
        {
          from_amount: '10',
          from_chain: 'solana',
          from_token: 'nep141:sol.omft.near',
          mode: 'TRANSFER',
          signer_id: 'alice.near',
          withdraws: [row(0)]
        },
        'solana'
      )
      expect(JSON.parse(calls[3].init.body).signer_chain_family).toBe('solana')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('preserves a private batch business rejection code', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 2002, msg: 'app fee does not match' }), { status: 200 })
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      await expect(api.submitWithdraws({ withdraws: [{}, {}] })).rejects.toMatchObject({
        status: 200,
        businessCode: 2002,
        ambiguous: false
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects malformed or mismatched private withdrawal history', async () => {
    const originalFetch = globalThis.fetch
    const signerId = '0x1111111111111111111111111111111111111111'
    const row = {
      transaction_type: 'WITHDRAW',
      sequence: 0,
      amount: '10',
      deposit_address: 'deposit-0',
      destination_address: '0x2222222222222222222222222222222222222222',
      destination_chain: 'eth',
      token: 'nep141:eth.omft.near',
      status: 'PENDING',
      scheduled_at: 12345,
      payload_deadline: 99999
    }
    let signer = signerId
    let includeUnrelatedDeposit = false
    let requestHeaders
    globalThis.fetch = async (_url, init) => {
      requestHeaders = init.headers
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            list: [
              ...(includeUnrelatedDeposit
                ? [
                    {
                      order: { order_id: 'other-order', signer_id: signer, status: 'PENDING' },
                      transactions: [
                        { transaction_type: 'DEPOSIT', amount: '10', status: 'PENDING' }
                      ]
                    }
                  ]
                : []),
              {
                order: { order_id: 'order-1', signer_id: signer, status: 'PENDING' },
                transactions: [row]
              }
            ],
            has_next_page: false
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
      await expect(
        api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })
      ).resolves.toMatchObject({
        orders: [{ transactions: [{ sequence: 0, scheduledAt: 12345, deadline: 99999 }] }]
      })
      expect(requestHeaders.Authentication).toBe('wallet-jwt')
      expect(requestHeaders.Authorization).toBeUndefined()
      includeUnrelatedDeposit = true
      const page = await api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })
      expect(page.orders).toHaveLength(2)
      expect(page.orders[0].transactions[0]).toMatchObject({
        transactionType: 'DEPOSIT',
        depositAddress: ''
      })
      expect(page.orders[0].transactions[0].sequence).toBeUndefined()
      signer = '0x3333333333333333333333333333333333333333'
      await expect(api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })).rejects.toThrow(
        'signer does not match'
      )
      signer = signerId
      row.deposit_address = ''
      await expect(api.getPrivateOrders({ walletToken: 'wallet-jwt', signerId })).rejects.toThrow(
        'deposit address is missing'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('binds wallet history authorization to a read-only SIWE challenge', async () => {
    const originalFetch = globalThis.fetch
    const walletAddress = '0x1111111111111111111111111111111111111111'
    const challengeId = 'challenge-1'
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const issuedAt = new Date().toISOString()
    const requestOrigin = `chrome-extension://${'a'.repeat(32)}`
    let messageOrigin = requestOrigin
    const message = scope =>
      `${new URL(messageOrigin).host} wants you to sign in with your Ethereum account:\n${walletAddress}\n\n` +
      `Authorize read-only access to confidential Unified Swap history.\n\n` +
      `URI: ${messageOrigin}\nVersion: 1\nChain ID: 1\nNonce: 12345678\n` +
      `Issued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: ${challengeId}\nResources:\n` +
      `- ${scope}\n- urn:rhea:wallet:evm:${walletAddress}\n- urn:rhea:app:ak_test`
    let scope = 'urn:rhea:swap:history:confidential:read'
    let queryAddress = walletAddress
    let proof
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/challenge')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              challengeId,
              expiresAt,
              chainFamily: 'evm',
              chainId: '1',
              address: walletAddress,
              walletAddress,
              identityKey: walletAddress,
              principalType: 'wallet',
              queryAddress,
              mcaAccountId: null,
              signingMethod: 'personal_sign',
              signingInput: { message: message(scope) }
            }
          }),
          { status: 200 }
        )
      }
      proof = JSON.parse(init.body).proof
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            token: 'wallet-jwt',
            tokenType: 'Bearer',
            expiresAt,
            scope: 'swap:history:confidential:read',
            principalType: 'wallet',
            queryAddress: walletAddress,
            mcaAccountId: null
          }
        }),
        { status: 200 }
      )
    }
    try {
      const api = new ConfidentialFundingApi(
        apiConfig,
        'https://near.example.test',
        'swap-jwt',
        requestOrigin
      )
      const challenge = await api.createOrderAuthChallenge({ walletAddress, chainId: '1' })
      await expect(
        api.authenticateOrderChallenge(challenge, {
          standard: 'erc191',
          payload: challenge.message,
          signature: `secp256k1:${'1'.repeat(65)}`
        })
      ).resolves.toMatchObject({ token: 'wallet-jwt' })
      expect(proof.signature).toBe(`0x${'00'.repeat(64)}1b`)
      for (const wrongOrigin of [
        `chrome-extension://${'b'.repeat(32)}`,
        'https://x.rhea.finance'
      ]) {
        messageOrigin = wrongOrigin
        await expect(api.createOrderAuthChallenge({ walletAddress, chainId: '1' })).rejects.toThrow(
          'not read-only'
        )
      }
      messageOrigin = requestOrigin
      scope = 'urn:rhea:swap:withdraw:write'
      await expect(api.createOrderAuthChallenge({ walletAddress, chainId: '1' })).rejects.toThrow(
        'not read-only'
      )
      scope = 'urn:rhea:swap:history:confidential:read'
      queryAddress = '0x3333333333333333333333333333333333333333'
      await expect(api.createOrderAuthChallenge({ walletAddress, chainId: '1' })).rejects.toThrow(
        'does not match account'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

const BITCOIN_CHAIN_ID = getBitcoinChainId('mainnet')
const BITCOIN_ASSET_ID = `${BITCOIN_CHAIN_ID}/slip44:0`
const BITCOIN_PROTOCOL_ASSET_ID = 'nep141:btc.omft.near'
const BITCOIN_PUBLIC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const BITCOIN_PRIVATE = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
const BITCOIN_DEPOSIT = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
const BITCOIN_LEGACY = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'

function bitcoinQuote(request, depositAddress) {
  return {
    correlationId: 'btc-quote',
    quoteRequest: {
      swapType: 'EXACT_INPUT',
      confidentiality: 'basic',
      originAsset: request.originAsset,
      destinationAsset: request.destinationAsset,
      amount: request.amountRaw,
      refundTo: request.refundTo ?? request.signerId,
      depositType: request.depositType,
      refundType: request.refundType,
      recipient: request.recipient,
      recipientType: request.recipientType,
      slippageTolerance: request.slippageBps
    },
    quote: {
      amountIn: request.amountRaw,
      amountOut: request.amountRaw,
      minAmountOut: request.amountRaw,
      depositAddress,
      deadline: new Date(120_000).toISOString()
    }
  }
}

const EVM_SIGNER = '0x1111111111111111111111111111111111111111'

function bitcoinMove(operation, sourceDomain, destinationDomain, extra = {}) {
  return {
    network: 'mainnet',
    keyDomainId: 'wallet:one',
    accountId: 'account:one',
    operation,
    sourceDomain,
    destinationDomain,
    source: {
      chainId: BITCOIN_CHAIN_ID,
      chainName: 'btc',
      assetId: BITCOIN_ASSET_ID,
      protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID,
      amountRaw: '1000'
    },
    destination: {
      chainId: BITCOIN_CHAIN_ID,
      chainName: 'btc',
      assetId: BITCOIN_ASSET_ID,
      protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID
    },
    slippageBps: 50,
    ...extra
  }
}

function bitcoinFundingCoordinator(options = {}) {
  const records = []
  const plans = []
  const quoteRequests = []
  const prepareInputs = []
  let quoteCalls = 0
  let prepareCalls = 0
  let identityChainId
  const confirmCalls = []
  const quoteError = options.quoteError
  const depositAddress = options.depositAddress ?? BITCOIN_DEPOSIT
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    api: {
      async quote(request) {
        quoteCalls += 1
        quoteRequests.push(request)
        if (options.quote) return options.quote(request)
        if (quoteError) throw quoteError
        return bitcoinQuote(request, depositAddress)
      },
      async getStatus() {
        return null
      },
      async getBalances() {
        return [
          {
            tokenId: confidentialPrivateTokenId(BITCOIN_PROTOCOL_ASSET_ID),
            available: '5000'
          }
        ]
      }
    },
    store: {
      async listPlans() {
        return plans
      },
      async getPlan(planId) {
        let match = null
        for (const plan of plans) {
          if (plan.planId === planId) match = plan
        }
        return match
      },
      async putPlan(plan) {
        plans.push(plan)
      },
      async getSession() {
        return {
          accessToken: 'synthetic',
          expiresAt: 1_000_000,
          signerId: EVM_SIGNER
        }
      },
      async putBalances() {},
      async listExternalDeposits() {
        return records
      },
      async putExternalDeposit(record) {
        records.push(record)
      },
      async withExternalDepositScope(_scope, operation) {
        return operation()
      }
    },
    signer: {
      async resolveIdentity(chainId) {
        identityChainId = chainId
        return {
          address: EVM_SIGNER,
          addressIndex: 0,
          peaAddress: '0x2222222222222222222222222222222222222222',
          context: {
            chainAccount: {
              scope: {
                keyDomainId: 'wallet:one',
                accountId: 'account:one',
                chainId
              }
            }
          }
        }
      },
      async resolveBitcoinPublicSpendAddress() {
        options.resolveCalls = (options.resolveCalls ?? 0) + 1
        return {
          sourceAddress: BITCOIN_PUBLIC,
          counterpartyAddress: BITCOIN_PRIVATE
        }
      },
      async resolveBitcoinFundingAddresses() {
        if (options.bitcoinFundingError) throw options.bitcoinFundingError
        const privateExecutionAddress = options.omitPrivateExecutionAddress
          ? undefined
          : (options.privateExecutionAddress ?? BITCOIN_PRIVATE)
        return {
          publicAddress: BITCOIN_PUBLIC,
          ...(privateExecutionAddress === undefined ? {} : { privateExecutionAddress })
        }
      },
      async prepareChainDeposit(input) {
        prepareCalls += 1
        prepareInputs.push(input)
        return {
          commandId: 'transaction:bitcoin:test',
          payloadFingerprint: 'ab'.repeat(32),
          expiresAt: 120_000,
          preparedTransfer: { family: 'bitcoin', chainId: BITCOIN_CHAIN_ID }
        }
      },
      async confirmTransaction(input) {
        confirmCalls.push(input)
        return {
          rawTransaction: '0200000001',
          transactionHash: '11'.repeat(32)
        }
      },
      async broadcastDeposit() {}
    },
    repository: options.repository ?? new InMemoryTransactionRepository(),
    assets: {
      get: id =>
        id === BITCOIN_ASSET_ID
          ? {
              asset: {
                id: BITCOIN_ASSET_ID,
                chainId: BITCOIN_CHAIN_ID,
                namespace: 'slip44',
                reference: '0',
                kind: 'native'
              },
              metadata: { symbol: 'BTC', decimals: 8 }
            }
          : undefined,
      list: () => []
    },
    protocolTokens: [
      {
        assetId: BITCOIN_PROTOCOL_ASSET_ID,
        blockchain: 'btc',
        decimals: 8,
        symbol: 'BTC'
      }
    ],
    evmNetworks: getEvmNetworkConfigs('mainnet'),
    assetMappings: [{ assetId: BITCOIN_ASSET_ID, protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID }],
    now: () => 1_000,
    createId: () => options.id ?? 'btc-funding',
    scheduleMonitoring: async () => {}
  })
  return {
    coordinator,
    records,
    plans,
    quoteRequests,
    prepareInputs,
    confirmCalls,
    counts: () => ({ quoteCalls, prepareCalls, identityChainId, resolveCalls: options.resolveCalls ?? 0 })
  }
}

test('Bitcoin external deposits use the EVM signer and create the shield graph', async () => {
  const repository = new InMemoryTransactionRepository()
  const harness = bitcoinFundingCoordinator({ repository, id: 'btc-external-one' })
  const source = {
    chainId: BITCOIN_CHAIN_ID,
    chainName: 'Bitcoin',
    assetId: BITCOIN_ASSET_ID,
    protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID,
    amountRaw: '1000'
  }
  const created = await harness.coordinator.createExternalDeposit({
    network: 'mainnet',
    keyDomainId: 'wallet:one',
    accountId: 'account:one',
    source,
    refundAddress: BITCOIN_PUBLIC,
    requestId: 'btc-public-refund'
  })
  expect(created.signerId).toBe('0x1111111111111111111111111111111111111111')
  expect(created.refundAddress).toBe(BITCOIN_PUBLIC)
  expect(created.depositAddress).toBe(BITCOIN_DEPOSIT)
  expect(harness.counts().identityChainId.startsWith('eip155:')).toBe(true)
  expect(created.transactionId).toBe('tx:confidential-external:btc-external-one')
  const graph = await repository.get(
    { keyDomainId: 'wallet:one', accountId: 'account:one' },
    created.transactionId
  )
  expect(graph.root.kind).toBe('shield')
  expect(graph.root.intent.shield.operation).toBe('deposit')

  const privateRefund = bitcoinFundingCoordinator({ id: 'btc-external-private' })
  const privateCreated = await privateRefund.coordinator.createExternalDeposit({
    network: 'mainnet',
    keyDomainId: 'wallet:one',
    accountId: 'account:one',
    source,
    refundAddress: BITCOIN_PRIVATE,
    requestId: 'btc-private-refund'
  })
  expect(privateCreated.refundAddress).toBe(BITCOIN_PRIVATE)

  await expect(
    harness.coordinator.createExternalDeposit({
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      refundAddress: 'not-a-bitcoin-address',
      requestId: 'btc-bad-refund'
    })
  ).rejects.toThrow('refund address is invalid')

  const badDeposit = bitcoinFundingCoordinator({
    id: 'btc-bad-deposit',
    depositAddress: BITCOIN_LEGACY
  })
  await expect(
    badDeposit.coordinator.createExternalDeposit({
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      refundAddress: BITCOIN_PUBLIC,
      requestId: 'btc-legacy-deposit'
    })
  ).rejects.toThrow('invalid deposit address')
  expect(badDeposit.records).toHaveLength(0)

  const intentsAccount = bitcoinFundingCoordinator({
    id: 'btc-intents-deposit',
    depositAddress: 'a'.repeat(64)
  })
  await expect(
    intentsAccount.coordinator.createExternalDeposit({
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      refundAddress: BITCOIN_PUBLIC,
      requestId: 'btc-intents-deposit'
    })
  ).rejects.toThrow('invalid deposit address')
  expect(intentsAccount.records).toHaveLength(0)
})

test('a non-Bitcoin bip122 origin is rejected before a quote or transfer', async () => {
  const harness = bitcoinFundingCoordinator()
  await expect(
    harness.coordinator.createExternalDeposit({
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source: {
        chainId: `bip122:${'cd'.repeat(16)}`,
        chainName: 'Other',
        assetId: `bip122:${'cd'.repeat(16)}/slip44:0`,
        protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID,
        amountRaw: '1000'
      },
      refundAddress: BITCOIN_PUBLIC,
      requestId: 'other-bip122'
    })
  ).rejects.toThrow('External Shield deposit request is invalid')
  expect(harness.counts().quoteCalls).toBe(0)
  expect(harness.records).toHaveLength(0)
})

test('a Bitcoin quote failure does not create a transfer', async () => {
  const failed = bitcoinFundingCoordinator({ quoteError: new Error('quote down') })
  await expect(
    failed.coordinator.prepare({
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      operation: 'deposit',
      sourceDomain: 'public',
      destinationDomain: 'shield',
      source: {
        chainId: BITCOIN_CHAIN_ID,
        chainName: 'btc',
        assetId: BITCOIN_ASSET_ID,
        protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID,
        amountRaw: '1000'
      },
      destination: {
        chainId: BITCOIN_CHAIN_ID,
        chainName: 'btc',
        assetId: BITCOIN_ASSET_ID,
        protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID
      },
      slippageBps: 50
    })
  ).rejects.toThrow('quote down')
  expect(failed.counts().prepareCalls).toBe(0)
  expect(failed.plans).toHaveLength(0)
})

test('a cluster split that is too low retries two withdrawals', async () => {
  let withdrawQuotes = 0
  const harness = bitcoinFundingCoordinator({
    quote(request) {
      if (request.depositType !== 'CONFIDENTIAL_INTENTS') {
        return bitcoinQuote(request, BITCOIN_DEPOSIT)
      }
      withdrawQuotes += 1
      if (withdrawQuotes <= 3) {
        throw new ConfidentialFundingApiError(
          'Amount is too low for bridge, try at least 3719',
          400,
          false
        )
      }
      return bitcoinQuote(request, 'a'.repeat(64))
    }
  })
  const move = bitcoinMove('cluster', 'public', 'private')
  move.source.amountRaw = '12000'
  const preview = await harness.coordinator.preview(move)
  expect(withdrawQuotes).toBe(5)
  expect(preview.amountOutRaw).toBe('12000')
})

test('a cluster that stays below the bridge floor reports the total minimum', async () => {
  const harness = bitcoinFundingCoordinator({
    quote(request) {
      if (request.depositType !== 'CONFIDENTIAL_INTENTS') {
        return bitcoinQuote(request, BITCOIN_DEPOSIT)
      }
      throw new ConfidentialFundingApiError(
        'Amount is too low for bridge, try at least 3719',
        400,
        false
      )
    }
  })
  const move = bitcoinMove('cluster', 'public', 'private')
  move.source.amountRaw = '5000'
  await expect(harness.coordinator.preview(move)).rejects.toThrow(/try at least 9298/)
  expect(harness.counts().quoteCalls).toBe(6)
})

test('a deposit quote minimum is not scaled by the cluster split', async () => {
  const harness = bitcoinFundingCoordinator({
    quote() {
      throw new ConfidentialFundingApiError(
        'Amount is too low for bridge, try at least 3719',
        400,
        false
      )
    }
  })
  const move = bitcoinMove('cluster', 'public', 'private')
  move.source.amountRaw = '12000'
  await expect(harness.coordinator.preview(move)).rejects.toThrow(/try at least 3719/)
  expect(harness.counts().quoteCalls).toBe(1)
})

test('a private Bitcoin deposit prepares the PEA and does not prepare when it is missing', async () => {
  const harness = bitcoinFundingCoordinator({ id: 'btc-private-deposit' })
  const review = await harness.coordinator.prepare(bitcoinMove('deposit', 'private', 'shield'))
  expect(harness.counts().identityChainId.startsWith('eip155:')).toBe(true)
  expect(review.requiresDeposit).toBe(true)
  expect(review.sourceAddress).toBe(BITCOIN_PRIVATE)
  expect(harness.plans[0].signerId).toBe(EVM_SIGNER)
  expect(harness.plans[0].source.address).toBe(BITCOIN_PRIVATE)
  expect(harness.quoteRequests[0]).toMatchObject({
    refundTo: BITCOIN_PRIVATE,
    signerId: EVM_SIGNER,
    recipient: EVM_SIGNER,
    depositType: 'ORIGIN_CHAIN',
    recipientType: 'CONFIDENTIAL_INTENTS'
  })
  expect(harness.prepareInputs).toEqual([
    expect.objectContaining({
      recipient: BITCOIN_DEPOSIT,
      amountRaw: '1000',
      sourceDomain: 'private',
      bitcoinSourceAddress: BITCOIN_PRIVATE,
      bitcoinCounterpartyAddress: BITCOIN_PUBLIC
    })
  ])

  const missingPea = bitcoinFundingCoordinator({
    id: 'btc-private-missing-pea',
    omitPrivateExecutionAddress: true
  })
  await expect(
    missingPea.coordinator.prepare(bitcoinMove('deposit', 'private', 'shield'))
  ).rejects.toThrow('Bitcoin private deposit signing is unavailable')
  expect(missingPea.counts().prepareCalls).toBe(0)
  expect(missingPea.counts().quoteCalls).toBe(0)
  expect(missingPea.plans).toHaveLength(0)

  const sameAddress = bitcoinFundingCoordinator({
    id: 'btc-private-public-pea',
    privateExecutionAddress: BITCOIN_PUBLIC
  })
  await expect(
    sameAddress.coordinator.prepare(bitcoinMove('deposit', 'private', 'shield'))
  ).rejects.toThrow('Bitcoin private deposit signing is unavailable')
  expect(sameAddress.counts().prepareCalls).toBe(0)
  expect(sameAddress.counts().quoteCalls).toBe(0)
  expect(sameAddress.plans).toHaveLength(0)
})

test('a private Bitcoin deposit confirms when the PEA matches and does not sign when it does not', async () => {
  const matching = bitcoinFundingCoordinator({ id: 'btc-private-confirm' })
  const review = await matching.coordinator.prepare(bitcoinMove('deposit', 'private', 'shield'))
  expect(matching.plans[0].source.address).toBe(BITCOIN_PRIVATE)
  expect(matching.plans[0].destination.address).toBe(EVM_SIGNER)
  const confirmed = await matching.coordinator.confirm(review.planId, review.payloadFingerprint)
  expect(confirmed.phase).toBe('deposit-confirming')
  expect(matching.confirmCalls).toEqual([
    expect.objectContaining({
      commandId: 'transaction:bitcoin:test',
      sourceDomain: 'private'
    })
  ])

  const changedPea = { id: 'btc-private-confirm-changed-pea' }
  const changed = bitcoinFundingCoordinator(changedPea)
  const changedReview = await changed.coordinator.prepare(
    bitcoinMove('deposit', 'private', 'shield')
  )
  changedPea.privateExecutionAddress = BITCOIN_PUBLIC
  await expect(
    changed.coordinator.confirm(changedReview.planId, changedReview.payloadFingerprint)
  ).rejects.toThrow('Active Wallet Account changed before private funding completed')
  expect(changed.confirmCalls).toHaveLength(0)
  expect(changed.plans[0].phase).toBe('prepared')

  const missingPea = { id: 'btc-private-confirm-missing-pea' }
  const missing = bitcoinFundingCoordinator(missingPea)
  const missingReview = await missing.coordinator.prepare(bitcoinMove('deposit', 'private', 'shield'))
  missingPea.omitPrivateExecutionAddress = true
  await expect(
    missing.coordinator.confirm(missingReview.planId, missingReview.payloadFingerprint)
  ).rejects.toThrow('Active Wallet Account changed before private funding completed')
  expect(missing.confirmCalls).toHaveLength(0)
  expect(missing.plans[0].phase).toBe('prepared')

  const unavailablePea = { id: 'btc-private-confirm-unavailable-pea' }
  const unavailable = bitcoinFundingCoordinator(unavailablePea)
  const unavailableReview = await unavailable.coordinator.prepare(
    bitcoinMove('deposit', 'private', 'shield')
  )
  unavailablePea.bitcoinFundingError = new Error('Bitcoin deposit signing is unavailable')
  await expect(
    unavailable.coordinator.confirm(unavailableReview.planId, unavailableReview.payloadFingerprint)
  ).rejects.toThrow('Active Wallet Account changed before private funding completed')
  expect(unavailable.confirmCalls).toHaveLength(0)
  expect(unavailable.plans[0].phase).toBe('prepared')

  const casedPea = { id: 'btc-private-confirm-cased-pea' }
  const cased = bitcoinFundingCoordinator(casedPea)
  const casedReview = await cased.coordinator.prepare(bitcoinMove('deposit', 'private', 'shield'))
  casedPea.privateExecutionAddress = BITCOIN_PRIVATE.toUpperCase()
  await expect(
    cased.coordinator.confirm(casedReview.planId, casedReview.payloadFingerprint)
  ).rejects.toThrow('Active Wallet Account changed before private funding completed')
  expect(cased.confirmCalls).toHaveLength(0)
  expect(cased.plans[0].phase).toBe('prepared')
})

test('Bitcoin withdraw signs with erc191 and does not pay the intents account', async () => {
  const harness = bitcoinFundingCoordinator({ depositAddress: 'ab'.repeat(32) })
  const review = await harness.coordinator.prepare({
    network: 'mainnet',
    keyDomainId: 'wallet:one',
    accountId: 'account:one',
    operation: 'withdraw',
    sourceDomain: 'shield',
    destinationDomain: 'public',
    externalRecipient: BITCOIN_PUBLIC,
    source: {
      chainId: BITCOIN_CHAIN_ID,
      chainName: 'btc',
      assetId: BITCOIN_ASSET_ID,
      protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID,
      amountRaw: '1000'
    },
    destination: {
      chainId: BITCOIN_CHAIN_ID,
      chainName: 'btc',
      assetId: BITCOIN_ASSET_ID,
      protocolAssetId: BITCOIN_PROTOCOL_ASSET_ID
    },
    slippageBps: 50
  })
  expect(harness.counts().identityChainId.startsWith('eip155:')).toBe(true)
  expect(harness.counts().prepareCalls).toBe(0)
  expect(review.requiresDeposit).toBe(false)
  expect(review.externalRecipient).toBe(BITCOIN_PUBLIC)
  expect(harness.plans[0].preparedDeposit).toBeUndefined()
})

test('a public and private Bitcoin cluster prepares a deposit from the source address', async () => {
  const publicToPrivate = bitcoinFundingCoordinator({ id: 'btc-cluster-public' })
  const review = await publicToPrivate.coordinator.prepare(
    bitcoinMove('cluster', 'public', 'private')
  )
  expect(publicToPrivate.counts().identityChainId.startsWith('eip155:')).toBe(true)
  expect(review.requiresDeposit).toBe(true)
  expect(review.sourceAddress).toBe(BITCOIN_PUBLIC)
  expect(review.destinationAddress).toBe(BITCOIN_PRIVATE)
  expect(publicToPrivate.plans[0].signerId).toBe(EVM_SIGNER)
  expect(publicToPrivate.quoteRequests[0]).toMatchObject({
    refundTo: BITCOIN_PUBLIC,
    signerId: EVM_SIGNER,
    recipient: EVM_SIGNER,
    depositType: 'ORIGIN_CHAIN',
    recipientType: 'CONFIDENTIAL_INTENTS'
  })
  expect(publicToPrivate.quoteRequests.length).toBeGreaterThan(1)
  for (const request of publicToPrivate.quoteRequests.slice(1)) {
    expect(request).toMatchObject({
      signerId: EVM_SIGNER,
      recipient: BITCOIN_PRIVATE,
      depositType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'DESTINATION_CHAIN'
    })
  }
  expect(publicToPrivate.prepareInputs).toEqual([
    expect.objectContaining({
      recipient: BITCOIN_DEPOSIT,
      sourceDomain: 'public',
      bitcoinSourceAddress: BITCOIN_PUBLIC,
      bitcoinCounterpartyAddress: BITCOIN_PRIVATE
    })
  ])

  const privateToPublic = bitcoinFundingCoordinator({ id: 'btc-cluster-private' })
  const privateReview = await privateToPublic.coordinator.prepare(
    bitcoinMove('cluster', 'private', 'public')
  )
  expect(privateToPublic.counts().identityChainId.startsWith('eip155:')).toBe(true)
  expect(privateReview.requiresDeposit).toBe(true)
  expect(privateReview.sourceAddress).toBe(BITCOIN_PRIVATE)
  expect(privateReview.destinationAddress).toBe(BITCOIN_PUBLIC)
  expect(privateToPublic.plans[0].signerId).toBe(EVM_SIGNER)
  expect(privateToPublic.quoteRequests[0]).toMatchObject({
    refundTo: BITCOIN_PRIVATE,
    signerId: EVM_SIGNER,
    recipient: EVM_SIGNER,
    depositType: 'ORIGIN_CHAIN'
  })
  expect(privateToPublic.prepareInputs).toEqual([
    expect.objectContaining({
      recipient: BITCOIN_DEPOSIT,
      amountRaw: '1000',
      sourceDomain: 'private',
      bitcoinSourceAddress: BITCOIN_PRIVATE,
      bitcoinCounterpartyAddress: BITCOIN_PUBLIC
    })
  ])

  const missingPea = bitcoinFundingCoordinator({
    id: 'btc-cluster-missing-pea',
    omitPrivateExecutionAddress: true
  })
  await expect(
    missingPea.coordinator.prepare(bitcoinMove('cluster', 'private', 'public'))
  ).rejects.toThrow('Bitcoin private deposit signing is unavailable')
  expect(missingPea.counts().prepareCalls).toBe(0)
  expect(missingPea.prepareInputs).toHaveLength(0)
  expect(missingPea.plans).toHaveLength(0)
  expect(missingPea.counts().quoteCalls).toBe(0)

  const shieldCluster = bitcoinFundingCoordinator({ id: 'btc-cluster-shield' })
  await expect(
    shieldCluster.coordinator.prepare(bitcoinMove('cluster', 'shield', 'public'))
  ).rejects.toThrow('Confidential funding requires an EVM signing chain')
  expect(shieldCluster.counts().quoteCalls).toBe(0)
  expect(shieldCluster.prepareInputs).toHaveLength(0)
})

test('a shield withdraw to the account Bitcoin address does not require an external recipient', async () => {
  const ownPublic = bitcoinFundingCoordinator({
    id: 'btc-withdraw-own-public',
    depositAddress: 'ab'.repeat(32)
  })
  const review = await ownPublic.coordinator.prepare(bitcoinMove('withdraw', 'shield', 'public'))
  expect(ownPublic.counts().identityChainId.startsWith('eip155:')).toBe(true)
  expect(review.externalRecipient).toBeUndefined()
  expect(review.destinationAddress).toBe(BITCOIN_PUBLIC)
  expect(review.requiresDeposit).toBe(false)
  expect(ownPublic.prepareInputs).toHaveLength(0)
  expect(ownPublic.quoteRequests[0]).toMatchObject({
    signerId: EVM_SIGNER,
    recipient: BITCOIN_PUBLIC,
    depositType: 'CONFIDENTIAL_INTENTS',
    recipientType: 'DESTINATION_CHAIN'
  })

  const ownPrivate = bitcoinFundingCoordinator({
    id: 'btc-withdraw-own-private',
    depositAddress: 'cd'.repeat(32)
  })
  const privateReview = await ownPrivate.coordinator.prepare(
    bitcoinMove('withdraw', 'shield', 'private')
  )
  expect(privateReview.externalRecipient).toBeUndefined()
  expect(privateReview.destinationAddress).toBe(BITCOIN_PRIVATE)
  expect(ownPrivate.prepareInputs).toHaveLength(0)
  expect(ownPrivate.quoteRequests[0].recipient).toBe(BITCOIN_PRIVATE)

  const external = bitcoinFundingCoordinator({ id: 'btc-withdraw-external' })
  const externalReview = await external.coordinator.prepare(
    bitcoinMove('withdraw', 'shield', 'public', { externalRecipient: BITCOIN_DEPOSIT })
  )
  expect(externalReview.externalRecipient).toBe(BITCOIN_DEPOSIT)
  expect(externalReview.destinationAddress).toBe(BITCOIN_DEPOSIT)
  expect(external.quoteRequests[0].recipient).toBe(BITCOIN_DEPOSIT)
  expect(external.prepareInputs).toHaveLength(0)
})

test('a Bitcoin cluster quote without a bc1 deposit address fails before a PSBT', async () => {
  const intentsAccount = bitcoinFundingCoordinator({
    id: 'btc-cluster-intents-account',
    depositAddress: 'ab'.repeat(32)
  })
  await expect(
    intentsAccount.coordinator.prepare(bitcoinMove('cluster', 'public', 'private'))
  ).rejects.toThrow('Confidential withdraw deposit is not a Bitcoin payment')
  expect(intentsAccount.prepareInputs).toHaveLength(0)
  expect(intentsAccount.plans).toHaveLength(0)

  const legacy = bitcoinFundingCoordinator({
    id: 'btc-cluster-legacy-deposit',
    depositAddress: BITCOIN_LEGACY
  })
  await expect(
    legacy.coordinator.prepare(bitcoinMove('cluster', 'public', 'private'))
  ).rejects.toThrow('Bitcoin deposit address must be a bc1 address')
  expect(legacy.prepareInputs).toHaveLength(0)
  expect(legacy.plans).toHaveLength(0)

  const walletAddress = bitcoinFundingCoordinator({
    id: 'btc-cluster-wallet-deposit',
    depositAddress: BITCOIN_PRIVATE
  })
  await expect(
    walletAddress.coordinator.prepare(bitcoinMove('cluster', 'public', 'private'))
  ).rejects.toThrow('Bitcoin deposit output pays another wallet address')
  expect(walletAddress.prepareInputs).toHaveLength(0)
  expect(walletAddress.plans).toHaveLength(0)
})

test('lists Shield BTC on mainnet when the protocol mapping exists', () => {
  const token = {
    assetId: BITCOIN_PROTOCOL_ASSET_ID,
    blockchain: 'btc',
    symbol: 'BTC',
    decimals: 8
  }
  const model = { chains: [], assets: [], confidential: { status: 'ready', assets: [] } }
  expect(listShieldFundingAssets(model, [], [token], 'mainnet').map(item => item.asset.asset.id)).toEqual([
    BITCOIN_ASSET_ID
  ])
  expect(listShieldFundingAssets(model, [], [token], 'testnet')).toEqual([])
  expect(depositTokenChainId(token)).toBe(BITCOIN_CHAIN_ID)
  const previousFlags = globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = [
    'chain.zcash',
    'chain.evm',
    'chain.bitcoin',
    'chain.near',
    'chain.solana'
  ]
  try {
    expect(depositSourceNetworks().some(chain => chain.family === 'bitcoin')).toBe(true)
  } finally {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = previousFlags
  }
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash', 'chain.evm']
  try {
    expect(depositSourceNetworks().some(chain => chain.family === 'bitcoin')).toBe(false)
  } finally {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = previousFlags
  }
})

function bitcoinDepositIdentity() {
  return {
    address: EVM_SIGNER,
    addressIndex: 0,
    peaAddress: '0x2222222222222222222222222222222222222222',
    context: {
      chainAccount: {
        scope: {
          keyDomainId: 'wallet:one',
          accountId: 'account:one',
          chainId: 'eip155:1'
        }
      }
    }
  }
}

function privateDepositReview(signer, outputs, id = 'transaction:bitcoin:pea') {
  return {
    graph: { root: { id } },
    review: {
      payloadFingerprint: { digestHex: 'ab'.repeat(32) },
      expiresAt: Date.now() + 60_000,
      summary: {
        schema: 'bitcoin.psbt.v1',
        fields: {
          feeSats: '150',
          signer,
          outputs
        }
      }
    }
  }
}

test('a private Bitcoin deposit PSBT spends the PEA and rejects another wallet output', async () => {
  const prepareCalls = []
  const rejected = []
  let review = privateDepositReview(BITCOIN_PRIVATE, [
    { address: BITCOIN_DEPOSIT, classification: 'recipient' },
    { address: BITCOIN_PRIVATE, classification: 'change' }
  ])
  const controller = {
    async prepare(...args) {
      prepareCalls.push(args)
      return review
    },
    async reject(commandId) {
      rejected.push(commandId)
    },
    async approve() {
      throw new Error('approve should not run')
    }
  }
  const client = createBitcoinConfidentialDepositClient(controller, {})
  const prepared = await client.preparePrivateDeposit({
    chainId: BITCOIN_CHAIN_ID,
    recipient: BITCOIN_DEPOSIT,
    amountRaw: '1000',
    privateExecutionAddress: BITCOIN_PRIVATE,
    publicReceiveAddress: BITCOIN_PUBLIC,
    counterpartyAddress: BITCOIN_LEGACY
  })
  expect(prepared.signerAddress).toBe(BITCOIN_PRIVATE)
  expect(prepared.networkFeeRaw).toBe('150')
  expect(prepareCalls).toEqual([
    [
      {
        recipient: BITCOIN_DEPOSIT,
        amount: { mode: 'exact', valueSats: '1000' }
      },
      undefined,
      'standard',
      'p2wpkh',
      undefined,
      undefined,
      'private'
    ]
  ])
  expect(rejected).toHaveLength(0)

  await expect(
    client.preparePrivateDeposit({
      chainId: BITCOIN_CHAIN_ID,
      recipient: BITCOIN_DEPOSIT,
      amountRaw: '1000',
      privateExecutionAddress: BITCOIN_PUBLIC,
      publicReceiveAddress: BITCOIN_PUBLIC
    })
  ).rejects.toThrow('Bitcoin private deposit signing is unavailable')
  expect(prepareCalls).toHaveLength(1)

  const rejectReview = async (nextReview, message) => {
    review = nextReview
    await expect(
      client.preparePrivateDeposit({
        chainId: BITCOIN_CHAIN_ID,
        recipient: BITCOIN_DEPOSIT,
        amountRaw: '1000',
        privateExecutionAddress: BITCOIN_PRIVATE,
        publicReceiveAddress: BITCOIN_PUBLIC,
        counterpartyAddress: BITCOIN_LEGACY
      })
    ).rejects.toThrow(message)
  }
  await rejectReview(
    privateDepositReview(
      BITCOIN_PUBLIC,
      [
        { address: BITCOIN_DEPOSIT, classification: 'recipient' },
        { address: BITCOIN_PRIVATE, classification: 'change' }
      ],
      'transaction:bitcoin:signer'
    ),
    'Bitcoin deposit source does not match the selected address'
  )
  await rejectReview(
    privateDepositReview(
      BITCOIN_PRIVATE,
      [
        { address: BITCOIN_DEPOSIT, classification: 'recipient' },
        { address: BITCOIN_PUBLIC, classification: 'change' }
      ],
      'transaction:bitcoin:public'
    ),
    'Bitcoin deposit output pays another wallet address'
  )
  await rejectReview(
    privateDepositReview(
      BITCOIN_PRIVATE,
      [
        { address: BITCOIN_DEPOSIT, classification: 'recipient' },
        { address: BITCOIN_LEGACY, classification: 'recipient' },
        { address: BITCOIN_PRIVATE, classification: 'change' }
      ],
      'transaction:bitcoin:other'
    ),
    'Bitcoin deposit output pays another wallet address'
  )
  await rejectReview(
    privateDepositReview(
      BITCOIN_PRIVATE,
      [
        { address: BITCOIN_DEPOSIT, classification: 'recipient' },
        { address: 'bc1qchange-not-the-pea', classification: 'change' }
      ],
      'transaction:bitcoin:change'
    ),
    'Bitcoin deposit outputs must pay the quote address and return change to the source'
  )
  expect(rejected).toEqual([
    'transaction:bitcoin:signer',
    'transaction:bitcoin:public',
    'transaction:bitcoin:other',
    'transaction:bitcoin:change'
  ])
})

test('private Bitcoin deposit signing prepares the PEA and skips prepare without one', async () => {
  const privateCalls = []
  const publicCalls = []
  const client = {
    async resolvePublicSpendAddress() {
      return { sourceAddress: BITCOIN_PUBLIC }
    },
    async preparePublicDeposit(input) {
      publicCalls.push(input)
      return {
        commandId: 'transaction:bitcoin:public',
        payloadFingerprint: 'cd'.repeat(32),
        expiresAt: Date.now() + 60_000,
        networkFeeRaw: '100',
        signerAddress: input.sourceAddress,
        outputs: [{ address: input.recipient }, { address: input.sourceAddress }]
      }
    },
    async preparePrivateDeposit(input) {
      privateCalls.push(input)
      return {
        commandId: 'transaction:bitcoin:private',
        payloadFingerprint: 'ab'.repeat(32),
        expiresAt: Date.now() + 60_000,
        networkFeeRaw: '100',
        signerAddress: input.privateExecutionAddress,
        outputs: [{ address: input.recipient }, { address: input.privateExecutionAddress }]
      }
    },
    async confirmPublicDeposit() {
      throw new Error('confirm should not run')
    },
    async rejectDeposit() {}
  }
  const signer = new ConfidentialFundingSigner({}, async () => null)
  signer.setBitcoinDepositClient(client)
  const request = {
    identity: bitcoinDepositIdentity(),
    chainId: BITCOIN_CHAIN_ID,
    assetKind: 'native',
    assetNamespace: 'slip44',
    assetReference: '0',
    assetId: BITCOIN_ASSET_ID,
    decimals: 8,
    recipient: BITCOIN_DEPOSIT,
    amountRaw: '1000',
    sourceDomain: 'private',
    bitcoinSourceAddress: BITCOIN_PRIVATE,
    bitcoinCounterpartyAddress: BITCOIN_PUBLIC
  }
  setBitcoinPrivateExecutionAddressReader(async () => BITCOIN_PRIVATE)
  try {
    const prepared = await signer.prepareChainDeposit(request)
    expect(prepared.preparedTransfer).toMatchObject({
      family: 'bitcoin',
      chainId: BITCOIN_CHAIN_ID,
      networkFeeRaw: '100'
    })
    expect(privateCalls).toEqual([
      {
        chainId: BITCOIN_CHAIN_ID,
        recipient: BITCOIN_DEPOSIT,
        amountRaw: '1000',
        privateExecutionAddress: BITCOIN_PRIVATE,
        publicReceiveAddress: BITCOIN_PUBLIC,
        counterpartyAddress: BITCOIN_PUBLIC
      }
    ])
    expect(publicCalls).toHaveLength(0)

    setBitcoinPrivateExecutionAddressReader(async () => undefined)
    await expect(signer.prepareChainDeposit(request)).rejects.toThrow(
      'Bitcoin private deposit signing is unavailable'
    )
    expect(privateCalls).toHaveLength(1)

    setBitcoinPrivateExecutionAddressReader(async () => BITCOIN_PUBLIC)
    await expect(
      signer.prepareChainDeposit({ ...request, bitcoinSourceAddress: undefined })
    ).rejects.toThrow('Bitcoin private deposit signing is unavailable')
    expect(privateCalls).toHaveLength(1)

    setBitcoinPrivateExecutionAddressReader(async () => BITCOIN_PRIVATE)
    await expect(
      signer.prepareChainDeposit({ ...request, bitcoinSourceAddress: BITCOIN_PUBLIC })
    ).rejects.toThrow('Bitcoin deposit source does not match the selected address')
    await expect(
      signer.prepareChainDeposit({ ...request, bitcoinSourceAddress: EVM_SIGNER })
    ).rejects.toThrow('Bitcoin deposit source does not match the selected address')
    expect(privateCalls).toHaveLength(1)

    await signer.prepareChainDeposit({
      ...request,
      sourceDomain: 'public',
      bitcoinSourceAddress: BITCOIN_PUBLIC,
      bitcoinCounterpartyAddress: BITCOIN_PRIVATE
    })
    expect(publicCalls).toEqual([
      expect.objectContaining({
        sourceAddress: BITCOIN_PUBLIC,
        recipient: BITCOIN_DEPOSIT,
        amountRaw: '1000'
      })
    ])
    expect(privateCalls).toHaveLength(1)
  } finally {
    setBitcoinPrivateExecutionAddressReader(undefined)
  }
})

test('a Bitcoin deposit PSBT rejects an output that pays the other wallet address', () => {
  initEccLib(secp256k1)
  const key = digit => {
    const privateKey = Buffer.alloc(32)
    privateKey[31] = digit
    const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
    const payment = payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin })
    return {
      publicKey,
      address: payment.address,
      payment
    }
  }
  const source = key(1)
  const deposit = key(2)
  const counterparty = key(3)
  const funding = new Transaction()
  funding.version = 2
  funding.addInput(Buffer.alloc(32), 0xffffffff)
  funding.addOutput(source.payment.output, 100000)
  const selectionFor = recipient =>
    selectBitcoinCoins({
      chainId: BITCOIN_CHAIN_ID,
      accountIndex: 0,
      addressType: 'p2wpkh',
      recipient,
      amount: { mode: 'exact', valueSats: '50000' },
      feeRateSatsPerVbyte: 2,
      utxos: [
        {
          chainId: BITCOIN_CHAIN_ID,
          addressType: 'p2wpkh',
          accountIndex: 0,
          change: false,
          addressIndex: 0,
          address: source.address,
          derivationPath: "m/84'/0'/0'/0/0",
          publicKey: `0x${source.publicKey.toString('hex')}`,
          transactionId: funding.getId(),
          outputIndex: 0,
          valueSats: '100000',
          blockHeight: 899_999
        }
      ]
    })
  const changeAddress = address => ({
    chainId: BITCOIN_CHAIN_ID,
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    address,
    addressScheme: 'bitcoin-p2wpkh',
    derivationScheme: 'bip84',
    derivationPath: "m/84'/0'/0'/0/0",
    publicKey: `0x${source.publicKey.toString('hex')}`
  })
  const previousTransactions = [
    { transactionId: funding.getId(), rawTransactionHex: funding.toHex() }
  ]
  const payingCounterparty = buildBitcoinPsbt({
    selection: selectionFor(counterparty.address),
    masterFingerprint: '0x01020304',
    lockTime: 900_000,
    previousTransactions,
    change: { address: changeAddress(source.address), outputPosition: 'last' }
  })
  expect(() =>
    assertBitcoinDepositOutputs({
      chainId: BITCOIN_CHAIN_ID,
      depositAddress: deposit.address,
      sourceAddress: source.address,
      counterpartyAddress: counterparty.address,
      outputs: [
        { address: payingCounterparty.recipient },
        { address: payingCounterparty.changeAddress }
      ]
    })
  ).toThrow('Bitcoin deposit output pays another wallet address')
  const valid = buildBitcoinPsbt({
    previousTransactions,
    selection: selectionFor(deposit.address),
    masterFingerprint: '0x01020304',
    lockTime: 900_000,
    change: { address: changeAddress(source.address), outputPosition: 'last' }
  })
  expect(() =>
    assertBitcoinDepositOutputs({
      chainId: BITCOIN_CHAIN_ID,
      depositAddress: deposit.address,
      sourceAddress: source.address,
      counterpartyAddress: counterparty.address,
      outputs: [
        { address: valid.recipient },
        { address: valid.changeAddress }
      ]
    })
  ).not.toThrow()
  expect(() =>
    assertBitcoinDepositOutputs({
      chainId: BITCOIN_CHAIN_ID,
      depositAddress: 'ab'.repeat(32),
      sourceAddress: source.address,
      outputs: [{ address: 'ab'.repeat(32) }]
    })
  ).toThrow('Confidential withdraw deposit is not a Bitcoin payment')
})
