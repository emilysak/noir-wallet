import { test } from 'node:test'
import { expect } from '@playwright/test'
import { withTimeout } from '../../../src/lib/async-utils.ts'

import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import {
  buildConfidentialPortfolioView,
  excludeDeprecatedConfidentialAssets,
  confidentialPrivateTokenId,
  filterConfidentialPortfolioMappings,
  getConfidentialAvailableForAsset,
  mergeConfidentialBalancesIntoPortfolio,
  mergeConfidentialSignerBalances,
  projectConfidentialOnlyEvmAssets
} from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBitcoinChainId,
  getBundledInitialProductAssetDefinitions
} from '../../../src/core/chains/registry/index.ts'
import { hidePortfolioAssets } from '../../../src/core/portfolio/portfolio-visibility.ts'
import { buildPortfolioReadModel, parsePortfolioReadModel } from '../../../src/core/portfolio/index.ts'
import { findAssetPrice } from '../../../src/core/prices/asset-price.ts'
import { listStandaloneNearConfidentialHoldings } from '../../../src/popup/services/near-confidential-holdings.ts'
import { withConfidentialAssetPrices } from '../../../src/popup/components/portfolio/portfolio-prices.ts'
import { getAssetDetailCategories } from '../../../src/popup/pages/portfolio/asset-detail-balance.ts'

test('projects Shield-only holdings independently of Public assets and preserves unknown tokens', () => {
  const protocolAssetId = 'nep141:usdc.omft.near'
  const assetId = 'eip155:1/erc20:0x1111111111111111111111111111111111111111'
  const zcashChainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const zcashAssetId = `${zcashChainId}/slip44:133`
  const zcashProtocolId = 'nep141:zec.omft.near'
  const bitcoinAssetId = `${getBitcoinChainId('mainnet')}/slip44:0`
  const bitcoinProtocolId = 'nep141:btc.omft.near'
  const token = {
    assetId: protocolAssetId,
    blockchain: 'eth',
    contractAddress: '0x1111111111111111111111111111111111111111',
    decimals: 6,
    symbol: 'USDC',
    price: 1,
    priceUpdatedAt: '2026-01-01T00:00:00Z'
  }
  const legacyId = 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r'
  const legacyBalance = Object.freeze({
    tokenId: confidentialPrivateTokenId(legacyId),
    available: '1000000000000000000'
  })
  const view = buildConfidentialPortfolioView(
    [
      legacyBalance,
      { tokenId: protocolAssetId, available: '9' },
      { tokenId: confidentialPrivateTokenId(protocolAssetId), available: '42' },
      { tokenId: confidentialPrivateTokenId(zcashProtocolId), available: '140000' },
      { tokenId: confidentialPrivateTokenId(bitcoinProtocolId), available: '7000' },
      { tokenId: 'unknown:asset', available: '7' }
    ],
    [
      token,
      { ...token, assetId: legacyId, symbol: 'USDC(DEPRECATED)', decimals: 18 },
      {
        assetId: zcashProtocolId,
        blockchain: 'zec',
        decimals: 8,
        symbol: 'ZEC',
        price: 0
      }
    ],
    [{ protocolAssetId, assetId, chainId: 'eip155:1', blockchain: 'eth' }],
    filterConfidentialPortfolioMappings(
      [
        { assetId, protocolAssetId },
        { assetId: zcashAssetId, protocolAssetId: zcashProtocolId },
        { assetId: bitcoinAssetId, protocolAssetId: bitcoinProtocolId }
      ],
      'mainnet'
    ),
    {
      get: id =>
        id === zcashAssetId
          ? { asset: { id: zcashAssetId, chainId: zcashChainId } }
          : id === bitcoinAssetId
            ? { asset: { id: bitcoinAssetId, chainId: getBitcoinChainId('mainnet') } }
            : undefined
    }
  )
  expect(view.status).toBe('ready')
  expect(getConfidentialAvailableForAsset([legacyBalance], legacyId)).toBe('1000000000000000000')
  expect(view.assets).toEqual([
    expect.objectContaining({
      tokenId: confidentialPrivateTokenId(protocolAssetId),
      protocolAssetId,
      availableRaw: '42',
      assetId,
      chainId: 'eip155:1',
      decimals: 6,
      priceUsd: '1'
    }),
    expect.objectContaining({
      tokenId: confidentialPrivateTokenId(zcashProtocolId),
      protocolAssetId: zcashProtocolId,
      availableRaw: '140000',
      assetId: zcashAssetId,
      chainId: zcashChainId,
      decimals: 8
    }),
    {
      tokenId: confidentialPrivateTokenId(bitcoinProtocolId),
      protocolAssetId: bitcoinProtocolId,
      availableRaw: '7000',
      assetId: bitcoinAssetId,
      chainId: getBitcoinChainId('mainnet')
    },
    { tokenId: 'unknown:asset', protocolAssetId: 'unknown:asset', availableRaw: '7' }
  ])
  expect(
    filterConfidentialPortfolioMappings(
      [{ assetId: zcashAssetId, protocolAssetId: zcashProtocolId }],
      'testnet'
    )
  ).toEqual([])
})

test('keeps NEAR, Solana, and Bitcoin Shield mappings and does not fold them into on-chain balances', () => {
  const nearAssetId = 'near:mainnet/slip44:397'
  const solanaAssetId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501'
  const bitcoinAssetId = `${getBitcoinChainId('mainnet')}/slip44:0`
  const otherBip122AssetId = `bip122:${'ab'.repeat(16)}/slip44:0`
  const mappings = filterConfidentialPortfolioMappings(
    [
      { assetId: nearAssetId, protocolAssetId: 'nep141:wrap.near' },
      { assetId: solanaAssetId, protocolAssetId: 'solana:nep141:sol.omft.near' },
      { assetId: 'eip155:1/slip44:60', protocolAssetId: 'nep141:eth.omft.near' },
      { assetId: bitcoinAssetId, protocolAssetId: 'nep141:btc.omft.near' },
      { assetId: otherBip122AssetId, protocolAssetId: 'nep141:btc.omft.near' },
      { assetId: `${getBitcoinChainId('testnet')}/slip44:0`, protocolAssetId: 'nep141:btc.omft.near' }
    ],
    'mainnet'
  )
  expect(mappings.map(mapping => mapping.assetId)).toEqual([
    nearAssetId,
    solanaAssetId,
    'eip155:1/slip44:60',
    bitcoinAssetId
  ])
  expect(
    filterConfidentialPortfolioMappings(
      [{ assetId: otherBip122AssetId, protocolAssetId: 'nep141:btc.omft.near' }],
      'mainnet'
    )
  ).toEqual([])
  const nearAsset = {
    asset: { id: nearAssetId },
    balance: {
      totalRaw: '14',
      mainRaw: '10',
      privateRaw: '4',
      spendableRaw: '14',
      availableRaw: '14'
    }
  }
  const solanaAsset = {
    asset: { id: solanaAssetId },
    balance: {
      totalRaw: '9',
      mainRaw: '6',
      privateRaw: '3',
      spendableRaw: '9',
      availableRaw: '9'
    }
  }
  const merged = mergeConfidentialBalancesIntoPortfolio(
    { assets: [nearAsset, solanaAsset], chains: [{ assets: [nearAsset] }, { assets: [solanaAsset] }] },
    mappings,
    [
      { tokenId: 'nep141:wrap.near', available: '7' },
      { tokenId: 'solana:nep141:sol.omft.near', available: '2' }
    ]
  )
  expect(merged.assets[0].balance).toEqual({ ...nearAsset.balance, confidentialRaw: '7' })
  const bitcoinAsset = {
    asset: { id: bitcoinAssetId },
    balance: {
      totalRaw: '15',
      mainRaw: '10',
      privateRaw: '5',
      spendableRaw: '10',
      availableRaw: '10',
      pendingRaw: '0'
    }
  }
  const bitcoinMerged = mergeConfidentialBalancesIntoPortfolio(
    { assets: [bitcoinAsset], chains: [{ assets: [bitcoinAsset] }] },
    [{ assetId: bitcoinAssetId, protocolAssetId: 'nep141:btc.omft.near' }],
    [{ tokenId: 'nep141:btc.omft.near', available: '7' }]
  )
  expect(bitcoinMerged.assets[0].balance.privateRaw).toBe('5')
  expect(bitcoinMerged.assets[0].balance.totalRaw).toBe('15')
  expect(bitcoinMerged.assets[0].balance.confidentialRaw).toBe('7')
  expect(merged.assets[1].balance).toEqual({ ...solanaAsset.balance, confidentialRaw: '2' })
  expect(merged.chains[0].assets[0].balance.confidentialRaw).toBe('7')
})

test('only counts the verified treasury token as Shield balance', () => {
  const asset = 'nep141:eth.omft.near'
  expect(
    getConfidentialAvailableForAsset(
      [
        { tokenId: `imt:${'a'.repeat(64)}:${asset}`, available: '9000' },
        { tokenId: asset, available: '7' },
        { tokenId: confidentialPrivateTokenId(asset), available: '42' }
      ],
      asset
    )
  ).toBe('42')
  expect(
    getConfidentialAvailableForAsset(
      [{ tokenId: `imt:${'a'.repeat(64)}:${asset}`, available: '9000' }],
      asset
    )
  ).toBeNull()
})

test('removes retired cached Shield balances from every projection without changing on-chain funds', () => {
  const legacyId = 'nep245:v2_1.omni.hot.tg:56_11111111111111111111'
  const currentId = 'nep141:bnb.omdep.near'
  const assetId = 'eip155:56/slip44:714'
  const holding = {
    tokenId: confidentialPrivateTokenId(legacyId),
    protocolAssetId: legacyId,
    assetId,
    chainId: 'eip155:56',
    symbol: 'BNB',
    decimals: 18,
    availableRaw: '25'
  }
  const asset = {
    asset: { id: assetId },
    balance: {
      totalRaw: '175',
      mainRaw: '100',
      privateRaw: '75',
      privateOnchainRaw: '50',
      confidentialRaw: '25',
      spendableRaw: '150',
      availableRaw: '150'
    }
  }
  const model = {
    assets: [asset],
    chains: [{ assets: [asset] }],
    confidential: { status: 'ready', assets: [holding] }
  }
  const filtered = excludeDeprecatedConfidentialAssets(model)
  expect(filtered.confidential.assets).toEqual([])
  expect(filtered.assets[0].balance).toEqual({
    ...asset.balance,
    totalRaw: '150',
    privateRaw: '50',
    confidentialRaw: '0'
  })
  expect(filtered.chains[0].assets[0]).toBe(filtered.assets[0])
  expect(excludeDeprecatedConfidentialAssets(filtered)).toBe(filtered)
  expect(model.assets[0].balance.totalRaw).toBe('175')
  expect(model.confidential.assets).toEqual([holding])

  const current = {
    ...holding,
    tokenId: confidentialPrivateTokenId(currentId),
    protocolAssetId: currentId,
    availableRaw: '7'
  }
  const both = excludeDeprecatedConfidentialAssets({
    ...model,
    confidential: { status: 'ready', assets: [holding, current] }
  })
  expect(both.confidential.assets).toEqual([current])
  expect(both.assets[0].balance).toMatchObject({
    totalRaw: '157',
    privateRaw: '57',
    confidentialRaw: '7',
    spendableRaw: '150'
  })
  expect(
    buildConfidentialPortfolioView(
      [{ tokenId: holding.tokenId, available: holding.availableRaw }],
      [],
      [],
      [],
      { get: () => undefined }
    ).assets
  ).toEqual([])
  expect(
    mergeConfidentialBalancesIntoPortfolio(
      model,
      [{ assetId, protocolAssetId: legacyId }],
      [{ tokenId: holding.tokenId, available: holding.availableRaw }]
    ).assets[0].balance.confidentialRaw
  ).toBe('0')
})

test('keeps Confidential balances out of directly spendable on-chain balances', () => {
  const asset = {
    asset: { id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111' },
    metadata: { decimals: 6, symbol: 'USDC' },
    source: 'bundled',
    balance: {
      totalRaw: '150',
      spendableRaw: '150',
      availableRaw: '150',
      pendingRaw: '0',
      mainRaw: '100',
      privateRaw: '50'
    },
    chainAccountIds: [],
    freshness: 'fresh',
    updatedAt: 1
  }
  const zcashAssetId = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
  const zcashAsset = {
    ...asset,
    asset: { id: zcashAssetId },
    metadata: { decimals: 8, symbol: 'ZEC' },
    balance: {
      totalRaw: '120',
      spendableRaw: '0',
      availableRaw: '0',
      pendingRaw: '0',
      transparentRaw: '80',
      shieldedRaw: '40'
    }
  }
  const model = {
    scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
    status: 'ready',
    assets: [asset, zcashAsset],
    chains: [
      { chain: { id: 'eip155:1' }, status: 'ready', assets: [asset], errorCodes: [] },
      {
        chain: { id: 'bip122:00040fe8ec8471911baa1db1266ea15d' },
        status: 'ready',
        assets: [zcashAsset],
        errorCodes: []
      }
    ],
    ignoredAssetCount: 0
  }
  const merged = mergeConfidentialBalancesIntoPortfolio(
    model,
    [
      { assetId: asset.asset.id, protocolAssetId: 'nep141:usdc.omft.near' },
      { assetId: zcashAssetId, protocolAssetId: 'nep141:zec.omft.near' }
    ],
    [
      { tokenId: 'nep141:usdc.omft.near', available: '25' },
      { tokenId: 'nep141:zec.omft.near', available: '40' }
    ]
  )
  expect(merged.assets[0].balance).toMatchObject({
    totalRaw: '175',
    spendableRaw: '150',
    availableRaw: '150',
    mainRaw: '100',
    privateRaw: '75',
    privateOnchainRaw: '50',
    confidentialRaw: '25'
  })
  expect(merged.assets[1].balance).toEqual(zcashAsset.balance)
})

test('projects a Confidential-only EVM token as its registered portfolio asset', () => {
  const chainId = 'eip155:56'
  const assetId = `${chainId}/erc20:0x1111111111111111111111111111111111111111`
  const nativeAssetId = `${chainId}/slip44:714`
  const protocolAssetId = 'nep141:rhea.omft.near'
  const holding = {
    tokenId: confidentialPrivateTokenId(protocolAssetId),
    protocolAssetId,
    assetId,
    chainId,
    decimals: 18,
    symbol: 'RHEA',
    availableRaw: '16533370000000000000',
    priceUsd: '0.032',
    priceUpdatedAt: new Date().toISOString()
  }
  const definition = {
    chainId,
    namespace: 'erc20',
    reference: '0x1111111111111111111111111111111111111111',
    kind: 'token',
    metadata: { name: 'RHEA', symbol: 'RHEA', decimals: 18 },
    source: 'protocol',
    verification: 'trusted'
  }
  const chains = createInitialProductChainRegistry('mainnet')
  const registry = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions('mainnet'),
    definition
  ])
  const entry = registry.resolve(assetId)
  const baseModel = buildPortfolioReadModel(
    { keyDomainId: 'key-domain:1', accountId: 'account:1' },
    [
      {
        chainAccount: {
          id: `chain-account:${chainId}`,
          scope: { keyDomainId: 'key-domain:1', accountId: 'account:1', chainId },
          derivation: { scheme: 'test', path: 'm/0' },
          identity: { kind: 'account-identifier', value: 'public-only' },
          createdAt: 1_700_000_000_000
        },
        status: 'ready',
        balances: [
          {
            assetId: nativeAssetId,
            totalRaw: '0',
            spendableRaw: '0',
            availableRaw: '0',
            pendingRaw: '0',
            mainRaw: '0',
            privateRaw: '0',
            updatedAt: 1_700_000_000_000
          }
        ]
      }
    ],
    chains,
    registry
  )
  const model = {
    ...baseModel,
    confidential: { status: 'ready', assets: [holding] }
  }
  const mappings = [{ assetId, protocolAssetId }]
  const projected = projectConfidentialOnlyEvmAssets(model, model.confidential, mappings, registry)
  const projectedAsset = projected.assets.find(asset => asset.asset.id === assetId)
  expect(projectedAsset).toBeDefined()
  expect(projected.chains[0].assets.at(-1)).toBe(projectedAsset)
  expect(projectedAsset.metadata).toBe(entry.metadata)
  expect(projectedAsset.chainAccountIds).toEqual(baseModel.assets[0].chainAccountIds)
  expect(projectedAsset.balance).toMatchObject({
    totalRaw: holding.availableRaw,
    mainRaw: '0',
    privateRaw: holding.availableRaw,
    privateOnchainRaw: '0',
    confidentialRaw: holding.availableRaw,
    spendableRaw: '0',
    availableRaw: '0'
  })
  expect(parsePortfolioReadModel(structuredClone(projected), chains, registry)).toEqual(projected)
  expect(listStandaloneNearConfidentialHoldings(projected, projected, null)).toEqual([])
  expect(findAssetPrice(withConfidentialAssetPrices(projected, null), assetId)?.priceUsd).toBe(
    '0.032'
  )
  expect(getAssetDetailCategories(projectedAsset, projected, true, '0.032').raw).toEqual({
    all: holding.availableRaw,
    public: '0',
    shield: holding.availableRaw,
    private: '0'
  })
  const hidden = hidePortfolioAssets({ ...projected, confidential: model.confidential }, [assetId])
  expect(hidden.assets.map(asset => asset.asset.id)).toEqual([nativeAssetId])
  expect(hidden.confidential.assets).toEqual([])
  expect(
    projectConfidentialOnlyEvmAssets(
      model,
      { status: 'ready', assets: [{ ...holding, chainId: 'eip155:1' }] },
      mappings,
      registry
    ).assets.map(asset => asset.asset.id)
  ).toEqual([nativeAssetId])
  expect(
    projectConfidentialOnlyEvmAssets(
      model,
      { status: 'ready', assets: [{ ...holding, decimals: 6 }] },
      mappings,
      registry
    ).assets.map(asset => asset.asset.id)
  ).toEqual([nativeAssetId])
  expect(
    projectConfidentialOnlyEvmAssets(
      model,
      { status: 'ready', assets: [{ ...holding, protocolAssetId: 'different' }] },
      mappings,
      registry
    ).assets.map(asset => asset.asset.id)
  ).toEqual([nativeAssetId])
})

test('only projects Confidential zero after a confirmed empty balance read', async () => {
  const asset = {
    asset: { id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111' },
    metadata: { decimals: 6, symbol: 'USDC' },
    balance: { totalRaw: '150', mainRaw: '100', privateRaw: '50' }
  }
  const model = {
    scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
    status: 'ready',
    assets: [asset],
    chains: [{ chain: { id: 'eip155:1' }, status: 'ready', assets: [asset] }]
  }
  let snapshot = { known: false, fresh: false, updatedAt: 0, balances: [] }
  let session = null
  let resolvedIdentity = false
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    store: {
      getBalanceSnapshot: async () => snapshot,
      getSession: async () => session,
      listPlans: async () => [],
      putBalances: async () => {}
    },
    api: {
      getBalances: async () => {
        throw new Error('balance service unavailable')
      }
    },
    signer: {
      resolveIdentity: async () => {
        resolvedIdentity = true
        return {
          context: {
            chainAccount: {
              scope: { keyDomainId: 'wallet:one', accountId: 'account:one' }
            }
          }
        }
      }
    },
    repository: {},
    assets: { get: () => undefined },
    evmNetworks: [{ chainId: 'eip155:1', rpcUrl: 'https://rpc.example.test' }],
    assetMappings: [{ assetId: asset.asset.id, protocolAssetId: 'nep141:usdc.omft.near' }],
    now: () => 1000
  })

  expect((await coordinator.enrichPortfolio(model)).confidential).toEqual({
    status: 'unavailable',
    freshness: 'unavailable',
    updatedAt: 0,
    assets: []
  })
  expect(resolvedIdentity).toBe(false)

  session = { accessToken: 'session', expiresAt: 1_000_000_000, refreshExpiresAt: 2_000_000_000 }
  expect((await coordinator.enrichPortfolio(model, false)).confidential).toEqual({
    status: 'unavailable',
    freshness: 'unavailable',
    updatedAt: 0,
    assets: []
  })
  expect(resolvedIdentity).toBe(false)
  expect((await coordinator.enrichPortfolio(model)).confidential).toEqual({
    status: 'unavailable',
    freshness: 'unavailable',
    updatedAt: 0,
    assets: []
  })
  expect(resolvedIdentity).toBe(true)

  snapshot = { known: true, fresh: true, updatedAt: 1000, balances: [] }
  const knownZero = await coordinator.enrichPortfolio(model)
  expect(knownZero.assets[0].balance).toMatchObject({
    totalRaw: '150',
    privateRaw: '50',
    privateOnchainRaw: '50',
    confidentialRaw: '0'
  })
  expect(knownZero.confidential).toEqual({
    status: 'ready', freshness: 'fresh', updatedAt: 1000, assets: []
  })

  snapshot = {
    known: true,
    fresh: false,
    updatedAt: 1000,
    balances: [{ tokenId: 'nep141:usdc.omft.near', available: '10', source: 'intents' }]
  }
  const stale = await coordinator.enrichPortfolio(model, false)
  expect(stale.confidential).toMatchObject({
    status: 'ready', freshness: 'stale', updatedAt: 1000
  })
  expect(stale.assets[0]).toMatchObject({
    freshness: 'stale',
    balance: { totalRaw: '160', privateRaw: '60', confidentialRaw: '10' }
  })
  expect(stale.status).toBe('partial')
  expect(stale.chains[0].status).toBe('partial')
})

test('notifies Portfolio only after a successful Confidential refresh for the active account', { timeout: 5000 }, async () => {
  const previousChrome = globalThis.chrome
  const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} }
  const updates = []
  globalThis.chrome = {
    storage: { local: storage, session: storage },
    runtime: { sendMessage: async message => updates.push(message) }
  }
  const { useWalletStore } = await import('../../../src/store/wallet-store.ts')
  const { getConfidentialFundingMessageHandler } = await import(
    '../../../src/background/confidential-funding-messages.ts'
  )
  const wallet = useWalletStore.getState()
  const previousScope = {
    currentNetwork: wallet.currentNetwork,
    currentWalletId: wallet.currentWalletId,
    currentAccountId: wallet.currentAccountId
  }
  const scope = { network: 'mainnet', keyDomainId: 'wallet:one', accountId: 'account:one' }
  const message = { scope, authorize: true }
  const handler = getConfidentialFundingMessageHandler('REFRESH_CONFIDENTIAL_BALANCES')
  const { AccountContextTransitionCoordinator } = await import(
    '../../../src/background/account-context-transition.ts'
  )
  const accountContextTransition = new AccountContextTransitionCoordinator()
  const context = refreshBalances => ({
    coordinator: { refreshBalances },
    accountContextTransition
  })
  try {
    Object.assign(wallet, {
      currentNetwork: 'mainnet',
      currentWalletId: scope.keyDomainId,
      currentAccountId: scope.accountId
    })
    const balances = [{ tokenId: 'token', available: '1', source: 'api' }]
    // A refresh may authorize through the signer, which serializes its own
    // account validation/signature. It must not wait behind its caller.
    expect(
      await handler(
        context(() => accountContextTransition.runActiveOperation(async () => balances)),
        message
      )
    ).toBe(balances)
    expect(updates).toEqual([
      { type: 'PORTFOLIO_UPDATED', walletId: scope.keyDomainId, accountId: scope.accountId }
    ])

    updates.length = 0
    await handler(context(async () => balances), { ...message, notifyPortfolio: false })
    expect(updates).toEqual([])

    await expect(
      handler(
        context(async () => {
          throw new Error('balance unavailable')
        }),
        message
      )
    ).rejects.toThrow('balance unavailable')
    expect(updates).toEqual([])

    await handler(
      context(async () => {
        wallet.currentAccountId = 'account:two'
        return balances
      }),
      message
    )
    expect(updates).toEqual([])

  } finally {
    Object.assign(wallet, previousScope)
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
  }
})

test(
  'native ZEC Confidential quote authorization does not block account switching',
  { timeout: 5000 },
  async () => {
    const previousChrome = globalThis.chrome
    const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} }
    globalThis.chrome = { storage: { local: storage, session: storage } }
    try {
      const { getConfidentialFundingMessageHandler } =
        await import('../../../src/background/confidential-funding-messages.ts')
      const { AccountContextTransitionCoordinator } =
        await import('../../../src/background/account-context-transition.ts')
      const transition = new AccountContextTransitionCoordinator()
      const events = []
      let active = { walletId: 'wallet:one', accountId: 'account:one' }
      const request = { walletId: active.walletId, accountId: active.accountId }
      const handler = getConfidentialFundingMessageHandler('PREPARE_NATIVE_ZEC_INTENTS_SWAP')
      const preparing = handler(
        {
          accountContextTransition: transition,
          coordinator: {
            prepareNativeZecIntentsSwap: async input => {
              expect(input).toBe(request)
              events.push('prepare')
              await transition.runActiveOperation(async () => {
                events.push('authorize')
              })
              events.push('quoted')
              return { quoteId: 'quote:one' }
            }
          }
        },
        { request }
      )
      const switching = transition.runAccountSwitch(
        { walletId: 'wallet:one', accountId: 'account:two' },
        {
          readCurrent: () => active,
          validateTarget: () => {},
          commit: async () => {
            active = { walletId: 'wallet:one', accountId: 'account:two' }
            events.push('switched')
          }
        }
      )
      const completed = await withTimeout(
        Promise.all([preparing, switching]),
        2000,
        'Native ZEC quote'
      )
      expect(completed[0]).toEqual({ quoteId: 'quote:one' })
      expect(active.accountId).toBe('account:two')
      expect(events).toEqual(['prepare', 'authorize', 'quoted', 'switched'])
    } finally {
      if (previousChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = previousChrome
    }
  }
)
test('merges NEAR and Solana signer balances without copying them into the EVM cache', async () => {
  const near = 'alice.near'
  const solana = '11111111111111111111111111111111'
  const evm = '0x1111111111111111111111111111111111111111'
  const nearBalances = [
    { tokenId: 'nep141:wrap.near', available: '500000000000000000000', source: 'private' },
    { tokenId: 'nep141:usdt.tether-token.near', available: '50000', source: 'private' }
  ]
  const solanaBalances = [{ tokenId: 'nep141:sol.omft.near', available: '7', source: 'private' }]
  const writes = []
  const now = 1_700_000_000_000
  const sessionFor = signerId => ({
    accessToken: signerId,
    refreshToken: `${signerId}-refresh`,
    expiresAt: now + 3_600_000,
    refreshExpiresAt: now + 86_400_000,
    signerId
  })
  const asset = {
    asset: { id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111' },
    metadata: { decimals: 6, symbol: 'USDC' },
    balance: { totalRaw: '150', mainRaw: '100', privateRaw: '50' }
  }
  const model = {
    scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
    assets: [asset],
    chains: [{ chain: { id: 'eip155:1' }, assets: [asset] }]
  }
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    now: () => now,
    store: {
      getBalanceSnapshot: async () => ({ fresh: true, balances: [] }),
      getSession: async (_network, _domain, _account, signerId) =>
        signerId ? sessionFor(signerId) : sessionFor(evm),
      putBalances: async (_network, _domain, _account, balances, signerId) => {
        writes.push({
          signerId: signerId ?? null,
          tokenIds: balances.map(row => row.tokenId)
        })
      },
      putSession: async () => {},
      deleteSession: async () => {},
      listFreshSignerBalances: async () => [
        { signerId: null, balances: [] },
        { signerId: near, balances: nearBalances }
      ],
      listNonEvmSessionSignerIds: async () => [near, solana]
    },
    api: {
      getBalances: async accessToken => {
        if (accessToken === near) return nearBalances
        if (accessToken === solana) return solanaBalances
        return []
      }
    },
    signer: {
      resolveIdentity: async chainId => ({
        address: String(chainId).startsWith('near:') ? near : evm,
        context: {
          chainAccount: {
            scope: {
              keyDomainId: 'wallet:one',
              accountId: 'account:one',
              chainId
            }
          }
        }
      })
    },
    repository: {},
    assets: { get: () => undefined, list: () => [] },
    evmNetworks: [{ chainId: 'eip155:1', rpcUrl: 'https://rpc.example.test' }],
    assetMappings: [{ assetId: asset.asset.id, protocolAssetId: 'nep141:usdc.omft.near' }],
    protocolTokens: []
  })

  const cached = await coordinator.enrichPortfolio(model, false)
  expect(cached.confidential.status).toBe('ready')
  expect(cached.confidential.assets.map(item => item.protocolAssetId).sort()).toEqual([
    'nep141:usdt.tether-token.near',
    'nep141:wrap.near'
  ])
  expect(writes).toEqual([])

  const balances = await coordinator.refreshBalances(
    { network: 'mainnet', keyDomainId: 'wallet:one', accountId: 'account:one' },
    false
  )
  expect(getConfidentialAvailableForAsset(balances, 'nep141:wrap.near')).toBe(
    '500000000000000000000'
  )
  expect(getConfidentialAvailableForAsset(balances, 'nep141:usdt.tether-token.near')).toBe('50000')
  expect(getConfidentialAvailableForAsset(balances, 'nep141:sol.omft.near')).toBe('7')
  expect(writes).toEqual([
    { signerId: evm, tokenIds: [] },
    { signerId: near, tokenIds: nearBalances.map(row => row.tokenId) },
    { signerId: solana, tokenIds: ['nep141:sol.omft.near'] }
  ])
  expect(
    writes.some(
      write =>
        (write.signerId === null || write.signerId === evm) &&
        write.tokenIds.some(id => id.includes('wrap.near') || id.includes('usdt'))
    )
  ).toBe(false)
})

test('authenticates a missing NEAR session and keeps the other signer balances', async () => {
  const near = 'alice.near'
  const evm = '0x1111111111111111111111111111111111111111'
  const solana = '11111111111111111111111111111111'
  const now = 1_700_000_000_000
  const nearBalances = [
    { tokenId: 'nep141:wrap.near', available: '500000000000000000000', source: 'private' },
    { tokenId: 'nep141:usdt.tether-token.near', available: '50000', source: 'private' }
  ]
  const solanaBalances = [{ tokenId: 'nep141:sol.omft.near', available: '7', source: 'private' }]
  let nearSignatures = 0
  const session = signerId => ({
    accessToken: signerId,
    refreshToken: `${signerId}-refresh`,
    expiresAt: now + 3_600_000,
    refreshExpiresAt: now + 86_400_000,
    signerId
  })
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    now: () => now,
    store: {
      getSession: async (_network, _domain, _account, signerId) => {
        if (signerId === near) return null
        if (signerId === solana) return session(solana)
        return session(evm)
      },
      putBalances: async () => {},
      putSession: async () => {},
      deleteSession: async () => {},
      listFreshSignerBalances: async () => [],
      listNonEvmSessionSignerIds: async () => [solana]
    },
    api: {
      getBalances: async accessToken => {
        if (accessToken === 'near-auth') return nearBalances
        if (accessToken === solana) return solanaBalances
        return []
      },
      createAuthPayload: async () => ({ standard: 'nep413', payload: '{"message":"auth"}' }),
      authenticate: async () => ({
        accessToken: 'near-auth',
        refreshToken: 'near-refresh',
        expiresAt: now + 3_600_000,
        refreshExpiresAt: now + 86_400_000
      })
    },
    signer: {
      resolveIdentity: async chainId => ({
        address: String(chainId).startsWith('near:') ? near : evm,
        context: {
          chainAccount: {
            scope: { keyDomainId: 'wallet:one', accountId: 'account:one', chainId }
          }
        }
      }),
      signMessage: async () => {
        nearSignatures += 1
        return { standard: 'nep413', payload: '{"message":"auth"}', signature: 'sig' }
      }
    },
    repository: {},
    assets: { get: () => undefined, list: () => [] },
    evmNetworks: [{ chainId: 'eip155:1', rpcUrl: 'https://rpc.example.test' }],
    assetMappings: []
  })

  const balances = await coordinator.refreshBalances(
    { network: 'mainnet', keyDomainId: 'wallet:one', accountId: 'account:one' },
    true
  )
  expect(nearSignatures).toBe(1)
  expect(getConfidentialAvailableForAsset(balances, 'nep141:wrap.near')).toBe(
    '500000000000000000000'
  )
  expect(getConfidentialAvailableForAsset(balances, 'nep141:usdt.tether-token.near')).toBe('50000')
  expect(getConfidentialAvailableForAsset(balances, 'nep141:sol.omft.near')).toBe('7')

  const rejected = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    now: () => now,
    store: {
      getSession: async (_network, _domain, _account, signerId) =>
        signerId === near ? null : session(signerId ?? evm),
      putBalances: async () => {},
      putSession: async () => {},
      deleteSession: async () => {},
      listFreshSignerBalances: async () => [],
      listNonEvmSessionSignerIds: async () => []
    },
    api: {
      getBalances: async () => [{ tokenId: 'nep141:eth.omft.near', available: '3', source: 'private' }],
      createAuthPayload: async () => ({ standard: 'nep413', payload: '{"message":"auth"}' })
    },
    signer: {
      resolveIdentity: async chainId => ({
        address: String(chainId).startsWith('near:') ? near : evm,
        context: {
          chainAccount: {
            scope: { keyDomainId: 'wallet:one', accountId: 'account:one', chainId }
          }
        }
      }),
      signMessage: async () => {
        throw new Error('NEAR signature rejected')
      }
    },
    repository: {},
    assets: { get: () => undefined, list: () => [] },
    evmNetworks: [{ chainId: 'eip155:1', rpcUrl: 'https://rpc.example.test' }],
    assetMappings: []
  })
  await expect(
    rejected.refreshBalances(
      { network: 'mainnet', keyDomainId: 'wallet:one', accountId: 'account:one' },
      true
    )
  ).resolves.toEqual([{ tokenId: 'nep141:eth.omft.near', available: '3', source: 'private' }])
})

test('sums the same confidential token across signer accounts once', () => {
  expect(
    mergeConfidentialSignerBalances([
      [{ tokenId: 'nep141:wrap.near', available: '2', source: 'evm' }],
      [
        { tokenId: 'nep141:wrap.near', available: '3', source: 'near' },
        { tokenId: 'nep141:usdt.tether-token.near', available: '50000', source: 'near' }
      ]
    ])
  ).toEqual([
    { tokenId: 'nep141:wrap.near', available: '5', source: 'evm' },
    { tokenId: 'nep141:usdt.tether-token.near', available: '50000', source: 'near' }
  ])
})
