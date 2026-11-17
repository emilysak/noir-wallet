import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createBackgroundConfidentialFundingCoordinator } from '../../../src/background/confidential-funding.ts'
import { ConfidentialFundingSigner } from '../../../src/background/confidential-funding-signer.ts'
import {
  getEvmNetworkConfigs,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '../../../src/config/networks.ts'
import { getActiveChainEndpointSettings } from '../../../src/core/chains/chain-endpoint-settings.ts'
import { parseChainId } from '../../../src/core/chains/registry/index.ts'
import { addConfidentialWalletChainMappings } from '../../../src/core/services/confidential-funding/index.ts'
import { prepareNearNativeTransfer } from '../../../src/infrastructure/chains/near/index.ts'
import { prepareSolanaNativeTransfer } from '../../../src/infrastructure/chains/solana/solana-transfer-preparer.ts'

const nearChainId = getNearNetworkConfig('mainnet').chainId
const nearNativeAssetId = `${nearChainId}/slip44:397`
const wrapNearProtocolAssetId = 'nep141:wrap.near'
const usdtAssetId = `${nearChainId}/nep141:usdt.tether-token.near`
const usdtProtocolAssetId = 'nep141:usdt.tether-token.near'
const evmAssetId = 'eip155:1/slip44:60'
const evmProtocolAssetId = 'nep141:eth.omft.near'
const parsedNearChainId = parseChainId(nearChainId).id
const peaAddress = 'ab'.repeat(32)

function token(overrides) {
  return {
    assetId: wrapNearProtocolAssetId,
    blockchain: 'near',
    contractAddress: 'wrap.near',
    decimals: 24,
    icon: null,
    price: 1,
    priceUpdatedAt: '2026-08-27T00:00:00.000Z',
    symbol: 'wNEAR',
    ...overrides
  }
}

function usdtToken(overrides = {}) {
  return token({
    assetId: usdtProtocolAssetId,
    contractAddress: 'usdt.tether-token.near',
    decimals: 6,
    symbol: 'USDT',
    ...overrides
  })
}

const solanaChainId = getSolanaNetworkConfig('mainnet').chainId
const solUsdcAssetId = `${solanaChainId}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

function assetsWithNear(decimals = 24) {
  return {
    get(assetId) {
      if (assetId === nearNativeAssetId) return { metadata: { decimals } }
      return undefined
    }
  }
}

function seedMappings() {
  const evm = Object.freeze({ assetId: evmAssetId, protocolAssetId: evmProtocolAssetId })
  return new Map([[evm.assetId, evm]])
}

test('maps native NEAR and NEAR wallet-catalog assets without replacing static mappings', () => {
  const mappings = seedMappings()
  addConfidentialWalletChainMappings(
    mappings,
    assetsWithNear(24),
    [token({ blockchain: 'NEAR' }), usdtToken()],
    'mainnet'
  )
  expect(mappings.get(evmAssetId)).toEqual({
    assetId: evmAssetId,
    protocolAssetId: evmProtocolAssetId
  })
  expect(mappings.get(nearNativeAssetId)).toEqual({
    assetId: nearNativeAssetId,
    protocolAssetId: wrapNearProtocolAssetId
  })
  expect(mappings.get(usdtAssetId)).toEqual({
    assetId: usdtAssetId,
    protocolAssetId: usdtProtocolAssetId
  })
})

test('skips native aliases off mainnet and when the chain registry rejects the lookup', () => {
  const testnet = seedMappings()
  addConfidentialWalletChainMappings(testnet, assetsWithNear(24), [token()], 'testnet')
  expect(testnet.has(nearNativeAssetId)).toBe(false)
  expect(testnet.get(evmAssetId)?.protocolAssetId).toBe(evmProtocolAssetId)

  const unsupported = seedMappings()
  addConfidentialWalletChainMappings(
    unsupported,
    {
      get() {
        throw new Error('Unsupported chain: near:mainnet')
      }
    },
    [token(), usdtToken()],
    'mainnet'
  )
  expect(unsupported.has(nearNativeAssetId)).toBe(false)
  expect(unsupported.get(evmAssetId)?.protocolAssetId).toBe(evmProtocolAssetId)
  expect(unsupported.get(usdtAssetId)?.protocolAssetId).toBe(usdtProtocolAssetId)
})

test('skips the native NEAR alias when decimals differ, the asset is missing, or the token is deprecated', () => {
  const mismatched = seedMappings()
  addConfidentialWalletChainMappings(mismatched, assetsWithNear(24), [token({ decimals: 18 })], 'mainnet')
  expect(mismatched.has(nearNativeAssetId)).toBe(false)
  expect(mismatched.get(evmAssetId)?.protocolAssetId).toBe(evmProtocolAssetId)

  const missing = seedMappings()
  expect(() =>
    addConfidentialWalletChainMappings(missing, { get: () => undefined }, [token()], 'mainnet')
  ).not.toThrow()
  expect(missing.has(nearNativeAssetId)).toBe(false)
  expect(missing.get(evmAssetId)?.protocolAssetId).toBe(evmProtocolAssetId)

  const deprecated = seedMappings()
  addConfidentialWalletChainMappings(
    deprecated,
    assetsWithNear(24),
    [token({ symbol: 'wNEAR(DEPRECATED)' })],
    'mainnet'
  )
  expect(deprecated.has(nearNativeAssetId)).toBe(false)

  const recovered = seedMappings()
  addConfidentialWalletChainMappings(
    recovered,
    assetsWithNear(24),
    [token({ symbol: 'wNEAR(DEPRECATED)' }), token()],
    'mainnet'
  )
  expect(recovered.get(nearNativeAssetId)?.protocolAssetId).toBe(wrapNearProtocolAssetId)
})

test('keeps static mappings when the wallet catalog is empty or conflicting', () => {
  const empty = seedMappings()
  addConfidentialWalletChainMappings(empty, assetsWithNear(24), [], 'mainnet')
  expect(empty.get(evmAssetId)?.protocolAssetId).toBe(evmProtocolAssetId)
  expect(empty.has(nearNativeAssetId)).toBe(false)

  const occupied = Object.freeze({
    assetId: usdtAssetId,
    protocolAssetId: 'nep141:kept.near'
  })
  const conflicting = seedMappings()
  conflicting.set(occupied.assetId, occupied)
  addConfidentialWalletChainMappings(
    conflicting,
    assetsWithNear(24),
    [
      token({
        assetId: 'nep141:sol-usdc.omft.near',
        blockchain: 'sol',
        contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        symbol: 'USDC'
      }),
      usdtToken(),
      usdtToken({ symbol: 'USDT.e', assetId: 'nep141:usdt-alt.near' }),
      token()
    ],
    'mainnet'
  )
  expect(conflicting.get(evmAssetId)?.protocolAssetId).toBe(evmProtocolAssetId)
  expect(conflicting.get(usdtAssetId)).toBe(occupied)
  expect(conflicting.has(solUsdcAssetId)).toBe(false)
  expect(conflicting.get(nearNativeAssetId)).toEqual({
    assetId: nearNativeAssetId,
    protocolAssetId: wrapNearProtocolAssetId
  })
})

function installFundingGlobals(t) {
  for (const key of ['__CONFIDENTIAL_ONE_CLICK_API_URL__', '__RHEA_SWAP_ACCESS_TOKEN__']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value: '', configurable: true })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else delete globalThis[key]
    })
  }
}

test('background coordinator keeps NEAR native mappings beside static EVM mappings', t => {
  installFundingGlobals(t)
  const create = tokens =>
    createBackgroundConfidentialFundingCoordinator(
      getEvmNetworkConfigs('mainnet'),
      [],
      [],
      [],
      tokens,
      getActiveChainEndpointSettings(),
      async () => {}
    )
  const nearSource = {
    chainId: nearChainId,
    chainName: 'near',
    assetId: nearNativeAssetId,
    protocolAssetId: wrapNearProtocolAssetId
  }
  const ethSource = {
    chainId: 'eip155:1',
    chainName: 'eth',
    assetId: evmAssetId,
    protocolAssetId: evmProtocolAssetId
  }
  const request = {
    network: 'mainnet',
    keyDomainId: 'wallet:one',
    accountId: 'account:one',
    operation: 'cluster',
    sourceDomain: 'public',
    destinationDomain: 'private',
    source: { ...nearSource, amountRaw: '1000' },
    destination: nearSource,
    slippageBps: 50
  }
  const mapped = create([token(), usdtToken()])
  expect(mapped.hasExternalDepositAsset(nearSource)).toBe(true)
  expect(mapped.hasCurrentFundingAssets(request)).toBe(true)
  expect(mapped.hasExternalDepositAsset(ethSource)).toBe(true)
  expect(create([token({ decimals: 18 })]).hasExternalDepositAsset(nearSource)).toBe(false)
  expect(create([]).hasExternalDepositAsset(ethSource)).toBe(true)
  expect(
    create([
      usdtToken(),
      usdtToken({ symbol: 'USDT.e', assetId: 'nep141:usdt-alt.near' }),
      token()
    ]).hasExternalDepositAsset(nearSource)
  ).toBe(true)
  expect(
    create([usdtToken(), usdtToken({ symbol: 'USDT.e', assetId: 'nep141:usdt-alt.near' })]).hasExternalDepositAsset(
      ethSource
    )
  ).toBe(true)
})

function nearPea(address) {
  return {
    address,
    publicKey: 'ed25519:pea',
    curve: 'ed25519',
    derivationScheme: 'pea_v2',
    parent: { accountIndex: 0 }
  }
}

function nearSigner(deriveNearPea, keyDomainSource = { kind: 'software' }) {
  return new ConfidentialFundingSigner(
    {},
    async () => null,
    async operation => operation(),
    {
      near: {
        client: { deriveNearPea },
        chainId: parsedNearChainId,
        loadContext: async () => ({
          chainAccount: {
            identity: { kind: 'account-identifier', value: 'alice.near' },
            scope: { keyDomainId: 'wallet:one', accountId: 'account:one' }
          },
          keyDomainSource,
          accountIndex: 0,
          publicKey: 'ed25519:alice'
        })
      }
    }
  )
}

test('NEAR confidential identity uses the derived PEA instead of the public account', async () => {
  let derivation
  const identity = await nearSigner(async (keyDomainId, accountIndex) => {
    derivation = { keyDomainId, accountIndex }
    return nearPea(peaAddress)
  }).resolveIdentity(parsedNearChainId)
  expect(derivation).toEqual({ keyDomainId: 'wallet:one', accountIndex: 0 })
  expect(identity.address).toBe('alice.near')
  expect(identity.addressIndex).toBe(0)
  expect(identity.peaAddress).toBe(peaAddress)
})

test('NEAR confidential identity rejects hardware keys and a PEA that matches the public account', async () => {
  const hardware = nearSigner(async () => {
    throw new Error('derive should not run')
  }, { kind: 'hardware' })
  await expect(hardware.resolveIdentity(parsedNearChainId)).rejects.toThrow(
    'NEAR private execution is unavailable'
  )
  const sameAccount = nearSigner(async () => nearPea('alice.near'))
  await expect(sameAccount.resolveIdentity(parsedNearChainId)).rejects.toThrow(
    'Confidential address must differ from the NEAR account'
  )
})

test('NEAR and Solana confidential deposits keep the prepared network fee', async () => {
  const publicKey = `ed25519:${'1'.repeat(32)}`
  const blockHash = '1'.repeat(32)
  const nearRpc = {
    assertExpectedChain: async () => {},
    getAccount: async accountId => ({
      accountId,
      amountRaw: '5000000000000000000000000',
      lockedRaw: '0',
      storageUsage: 100,
      codeHash: blockHash,
      blockHash,
      blockHeight: 10
    }),
    getAccessKey: async () => ({
      accountId: 'alice.near',
      publicKey,
      nonce: '41',
      permission: { kind: 'full-access' },
      blockHash,
      blockHeight: 10
    }),
    getGasPrice: async () => '100000000',
    getNativeTransferCostConfig: async () => ({
      chainId: parsedNearChainId,
      minGasPurchasePriceRaw: '1000000000',
      storageAmountPerByteRaw: '10000000000000000000',
      actionReceiptCreation: {
        executionGas: '108059500000',
        sendNotSirGas: '108059500000',
        sendSirGas: '108059500000'
      },
      transfer: {
        executionGas: '115123062500',
        sendNotSirGas: '115123062500',
        sendSirGas: '115123062500'
      }
    })
  }
  const near = new ConfidentialFundingSigner(
    {},
    async () => null,
    async operation => operation(),
    {
      near: {
        client: {
          deriveNearPea: async () => nearPea(peaAddress),
          prepare: async () => ({
            commandId: 'command-near',
            payloadFingerprint: { digestHex: 'a'.repeat(64) },
            expiresAt: Date.now() + 60_000,
            operation: 'transaction',
            summary: { review: { level: 'standard' } }
          })
        },
        rpc: nearRpc,
        chainId: parsedNearChainId,
        loadContext: async () => ({
          chainAccount: {
            identity: { kind: 'account-identifier', value: 'alice.near' },
            scope: { keyDomainId: 'wallet:one', accountId: 'account:one' }
          },
          keyDomainSource: { kind: 'software' },
          accountIndex: 0,
          publicKey
        })
      }
    }
  )
  const nearIdentity = await near.resolveIdentity(parsedNearChainId)
  const nearPrepared = await prepareNearNativeTransfer({
    chainId: parsedNearChainId,
    accountIndex: 0,
    signerId: 'alice.near',
    publicKey,
    receiverId: 'bob.near',
    depositYocto: '2000000000000000000000000',
    rpc: nearRpc
  })
  const nearDeposit = await near.prepareChainDeposit({
    identity: nearIdentity,
    chainId: parsedNearChainId,
    assetKind: 'native',
    assetNamespace: 'slip44',
    assetReference: '397',
    assetId: nearNativeAssetId,
    decimals: 24,
    recipient: 'bob.near',
    amountRaw: '2000000000000000000000000',
    sourceDomain: 'public'
  })
  expect(nearDeposit.preparedTransfer.networkFeeRaw).toBe(nearPrepared.maximumFeeYocto)

  const solanaChainId = getSolanaNetworkConfig('mainnet').chainId
  const solanaSender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
  const solanaRecipient = 'SysvarRent111111111111111111111111111111111'
  const solanaRpc = {
    assertExpectedChain: async () => {},
    getBalanceSnapshot: async () => ({ contextSlot: 10, amountRaw: '10000' }),
    getLatestBlockhash: async () => ({
      contextSlot: 11,
      blockhash: 'SysvarC1ock11111111111111111111111111111111',
      lastValidBlockHeight: 99
    }),
    getFeeForMessage: async () => ({ contextSlot: 12, feeLamports: '5000' }),
    simulateTransaction: async () => ({ contextSlot: 13, unitsConsumed: 150 })
  }
  const solana = new ConfidentialFundingSigner(
    {},
    async () => null,
    async operation => operation(),
    {
      solana: {
        client: {
          deriveSolanaPea: async () => ({ address: '11111111111111111111111111111111' }),
          prepare: async () => ({
            commandId: 'command-solana',
            payloadFingerprint: { digestHex: 'b'.repeat(64) },
            expiresAt: Date.now() + 60_000,
            operation: 'transaction',
            summary: { review: { level: 'standard' } }
          })
        },
        rpc: solanaRpc,
        chainId: solanaChainId,
        loadContext: async () => ({
          chainAccount: {
            identity: { kind: 'account-identifier', value: solanaSender },
            scope: { keyDomainId: 'wallet:one', accountId: 'account:one' }
          },
          keyDomainSource: { kind: 'software' },
          accountIndex: 0
        })
      }
    }
  )
  const solanaIdentity = await solana.resolveIdentity(solanaChainId)
  const solanaPrepared = await prepareSolanaNativeTransfer({
    chainId: solanaChainId,
    sender: solanaSender,
    recipient: solanaRecipient,
    lamports: '1000',
    rpc: solanaRpc
  })
  const solanaDeposit = await solana.prepareChainDeposit({
    identity: solanaIdentity,
    chainId: solanaChainId,
    assetKind: 'native',
    assetNamespace: 'slip44',
    assetReference: '501',
    assetId: `${solanaChainId}/slip44:501`,
    decimals: 9,
    recipient: solanaRecipient,
    amountRaw: '1000',
    sourceDomain: 'public'
  })
  expect(solanaDeposit.preparedTransfer.networkFeeRaw).toBe(solanaPrepared.feeLamports)
  expect(solanaDeposit.preparedTransfer.transactionBase64).toBeUndefined()
})
