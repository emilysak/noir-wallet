import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  getBitcoinNetworkConfig,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '../../../src/config/networks.ts'
import { resolveShieldManagedAsset } from '../../../src/popup/services/shield-transfer.ts'
import { findDirectConfidentialChainToken } from '../../../src/popup/services/move-method-estimate.ts'

const nearChainId = getNearNetworkConfig('mainnet').chainId
const solanaChainId = getSolanaNetworkConfig('mainnet').chainId
const bitcoinChainId = getBitcoinNetworkConfig('mainnet').chainId

function walletAsset(chainId, reference, namespace, kind, decimals) {
  return {
    asset: {
      id: `${chainId}/${namespace}:${reference}`,
      chainId,
      namespace,
      reference,
      kind
    },
    metadata: { name: reference, symbol: reference, decimals }
  }
}

const nativeNear = walletAsset(nearChainId, '397', 'slip44', 'native', 24)
const nativeSol = walletAsset(solanaChainId, '501', 'slip44', 'native', 9)
const nativeBtc = walletAsset(bitcoinChainId, '0', 'slip44', 'native', 8)
const wrapNear = {
  assetId: 'nep141:wrap.near',
  blockchain: 'near',
  contractAddress: 'wrap.near',
  decimals: 24
}

test('resolves native NEAR to wrapped NEAR even when the catalog row has a contract', () => {
  expect(resolveShieldManagedAsset(nativeNear, [], [wrapNear], 'mainnet')).toEqual({
    assetId: 'near:mainnet/slip44:397',
    chainId: 'near:mainnet',
    protocolAssetId: 'nep141:wrap.near',
    blockchain: 'near'
  })
  expect(
    resolveShieldManagedAsset(nativeNear, [], [{ ...wrapNear, decimals: 18 }], 'mainnet')
  ).toBeNull()
  expect(resolveShieldManagedAsset(nativeNear, [], [wrapNear], 'testnet')).toBeNull()
  expect(
    resolveShieldManagedAsset(
      walletAsset('near:testnet', '397', 'slip44', 'native', 24),
      [],
      [wrapNear],
      'mainnet'
    )
  ).toBeNull()
  expect(
    resolveShieldManagedAsset(
      walletAsset(nearChainId, 'wrap.near', 'nep141', 'token', 24),
      [],
      [wrapNear],
      'mainnet'
    )
  ).toEqual({
    assetId: 'near:mainnet/nep141:wrap.near',
    chainId: 'near:mainnet',
    protocolAssetId: 'nep141:wrap.near',
    blockchain: 'near'
  })
})

test('resolves native SOL to the wrapped SOL protocol asset the same way', () => {
  const wrappedSol = {
    assetId: 'nep141:sol.omft.near',
    blockchain: 'sol',
    contractAddress: 'So11111111111111111111111111111111111111112',
    decimals: 9
  }
  expect(resolveShieldManagedAsset(nativeSol, [], [wrappedSol], 'mainnet')).toEqual({
    assetId: `${solanaChainId}/slip44:501`,
    chainId: solanaChainId,
    protocolAssetId: 'nep141:sol.omft.near',
    blockchain: 'sol'
  })
  expect(
    resolveShieldManagedAsset(nativeSol, [], [{ ...wrappedSol, decimals: 8 }], 'mainnet')
  ).toBeNull()
  expect(resolveShieldManagedAsset(nativeSol, [], [wrappedSol], 'testnet')).toBeNull()
})

test('direct confidential moves quote the native protocol token and not another catalog row', () => {
  const decoy = {
    assetId: 'nep141:usdt.tether-token.near',
    blockchain: 'near',
    contractAddress: 'usdt.tether-token.near',
    decimals: 24,
    symbol: 'USDT',
    rheaAddress: 'usdt.tether-token.near'
  }
  const wrapped = { ...wrapNear, symbol: 'wNEAR', rheaAddress: 'wrap.near' }
  expect(findDirectConfidentialChainToken([decoy, wrapped], nativeNear)).toBe(wrapped)
  expect(
    findDirectConfidentialChainToken([decoy, { ...wrapped, decimals: 18 }], nativeNear)
  ).toBeUndefined()

  const nativeAlias = {
    assetId: 'nep141:wrap.near',
    blockchain: 'near',
    contractAddress: null,
    decimals: 24,
    symbol: 'NEAR',
    rheaAddress: 'near'
  }
  expect(findDirectConfidentialChainToken([wrapped, nativeAlias], nativeNear)).toBe(nativeAlias)

  const wrappedSol = {
    assetId: 'nep141:sol.omft.near',
    blockchain: 'sol',
    contractAddress: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'SOL',
    rheaAddress: 'So11111111111111111111111111111111111111112'
  }
  expect(findDirectConfidentialChainToken([decoy, wrapped, wrappedSol], nativeSol)).toBe(wrappedSol)

  const wrappedBtc = {
    assetId: 'nep141:btc.omft.near',
    blockchain: 'btc',
    contractAddress: null,
    decimals: 8,
    symbol: 'BTC',
    rheaAddress: 'btc'
  }
  expect(findDirectConfidentialChainToken([decoy, wrappedBtc], nativeBtc)).toBe(wrappedBtc)
  expect(
    findDirectConfidentialChainToken([decoy, { ...wrappedBtc, decimals: 6 }], nativeBtc)
  ).toBeUndefined()
})

test('resolves native BTC to nep141:btc.omft.near on mainnet only', () => {
  const wrappedBtc = {
    assetId: 'nep141:btc.omft.near',
    blockchain: 'btc',
    decimals: 8
  }
  expect(resolveShieldManagedAsset(nativeBtc, [], [wrappedBtc], 'mainnet')).toEqual({
    assetId: `${bitcoinChainId}/slip44:0`,
    chainId: bitcoinChainId,
    protocolAssetId: 'nep141:btc.omft.near',
    blockchain: 'btc'
  })
  expect(resolveShieldManagedAsset(nativeBtc, [], [{ ...wrappedBtc, decimals: 6 }], 'mainnet')).toBeNull()
  expect(resolveShieldManagedAsset(nativeBtc, [], [wrappedBtc], 'testnet')).toBeNull()
})
