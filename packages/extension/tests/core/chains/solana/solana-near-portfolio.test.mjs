import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import {
  createAddressGatedChainRegistry,
  createAssetRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { NearRpcError } from '../../../../src/infrastructure/chains/near/near-rpc-types.ts'
import { readNearPortfolioSource } from '../../../../src/infrastructure/chains/near/near-portfolio-source.ts'
import { SolanaRpcError } from '../../../../src/infrastructure/chains/solana/solana-rpc-types.ts'
import { readSolanaPortfolioSource } from '../../../../src/infrastructure/chains/solana/solana-portfolio-source.ts'
import {
  SingleChainPortfolioCoordinator,
  UnifiedPortfolioCoordinator
} from '../../../../src/infrastructure/portfolio/index.ts'

const generationId = 'storage-v2:generation:solana-near-portfolio'
const keyDomainId = 'wallet:solana-near-portfolio'
const accountId = 'account:solana-near-portfolio:0'
const solanaChainId = SOLANA_NETWORKS.devnet.chainId
const nearChainId = NEAR_NETWORKS.testnet.chainId
const solanaAddress = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const nearAddress = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const blockHash = '11111111111111111111111111111111'

const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.solana',
  'chain.near'
])
const assets = createAssetRegistry(
  chains,
  filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains)
)
const solanaUsdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const shownSolanaMint = 'So11111111111111111111111111111111111111112'
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes) {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] * 256
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1
  return `${'1'.repeat(zeros)}${digits
    .reverse()
    .map(digit => BASE58_ALPHABET[digit])
    .join('')}`
}

const solanaCatalogMints = Array.from({ length: 300 }, () => encodeBase58(randomBytes(32)))
const assetsWithSolanaUsdc = createAssetRegistry(chains, [
  ...filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains),
  {
    chainId: solanaChainId,
    namespace: 'token',
    reference: solanaUsdcMint,
    kind: 'token',
    metadata: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    source: 'protocol',
    verification: 'trusted'
  }
])
const nearUsdtContract = 'usdt.tether-token.near'
function assetsWithNearCatalog(count) {
  const tokens = Array.from({ length: count }, (_, index) => {
    const contractId =
      index === 0 ? nearUsdtContract : `token${String(index).padStart(2, '0')}.testnet`
    return {
      chainId: nearChainId,
      namespace: 'nep141',
      reference: contractId,
      kind: 'token',
      metadata: {
        name: index === 0 ? 'Tether USD' : `Token ${index}`,
        symbol: index === 0 ? 'USDT' : `T${index}`,
        decimals: 6
      },
      source: 'protocol',
      verification: 'trusted'
    }
  })
  return createAssetRegistry(chains, [
    ...filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains),
    ...tokens
  ])
}
const assetsWithNearUsdt = createAssetRegistry(chains, [
  ...filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains),
  {
    chainId: nearChainId,
    namespace: 'nep141',
    reference: nearUsdtContract,
    kind: 'token',
    metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
    source: 'protocol',
    verification: 'trusted'
  }
])

const solanaChainAccount = Object.freeze({
  id: 'chain-account:solana-near-portfolio:solana',
  scope: { keyDomainId, accountId, chainId: solanaChainId },
  derivation: { scheme: 'slip10', path: "m/44'/501'/0'/0'" },
  identity: { kind: 'account-identifier', value: solanaAddress },
  createdAt: 1_000
})
const nearChainAccount = Object.freeze({
  id: 'chain-account:solana-near-portfolio:near',
  scope: { keyDomainId, accountId, chainId: nearChainId },
  derivation: { scheme: 'slip10', path: "m/44'/397'/0'" },
  identity: { kind: 'account-identifier', value: nearAddress },
  createdAt: 1_000
})

function solanaRpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getBalanceSnapshot: async () => ({ contextSlot: 10, amountRaw: '1234567890' }),
    getTokenAccountsByMints: async () => {
      throw new Error('Native-only Portfolio must not enumerate SPL token accounts')
    },
    ...overrides
  }
}

function nearRpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getAccount: async requestedAccountId => ({
      accountId: requestedAccountId,
      amountRaw: '100',
      lockedRaw: '20',
      storageUsage: 30,
      codeHash: blockHash,
      blockHash,
      blockHeight: 40
    }),
    getFinalBlock: async () => ({
      hash: blockHash,
      height: 41,
      timestampNanosec: '1',
      gasPriceRaw: '1'
    }),
    getFungibleTokenBalance: async () => {
      throw new Error('Native-only Portfolio must not query NEP-141 balances')
    },
    ...overrides
  }
}

function pointer() {
  return {
    schemaVersion: 2,
    generationId,
    sourceFingerprint: 'a'.repeat(64),
    committedAt: 1_000
  }
}

function snapshot() {
  return {
    manifest: {
      schemaVersion: 2,
      generationId,
      status: 'verified',
      sourceFingerprint: 'a'.repeat(64),
      mainKeyDomainId: keyDomainId,
      activeAccount: { keyDomainId, accountId }
    },
    keyDomains: [
      {
        id: keyDomainId,
        credentialRef: 'credential-set:solana-near-portfolio',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Wallet 1',
        createdAt: 1_000
      }
    ],
    accounts: [
      {
        id: accountId,
        keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_000
      }
    ],
    chainAccounts: [solanaChainAccount, nearChainAccount],
    addresses: [
      {
        id: 'address:solana-near-portfolio:solana',
        chainAccountId: solanaChainAccount.id,
        value: solanaAddress,
        scheme: 'solana',
        purpose: 'identity',
        derivation: solanaChainAccount.derivation,
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      },
      {
        id: 'address:solana-near-portfolio:near',
        chainAccountId: nearChainAccount.id,
        value: nearAddress,
        scheme: 'near',
        purpose: 'identity',
        derivation: nearChainAccount.derivation,
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    ]
  }
}

test.describe('Solana and NEAR address-only Portfolio', () => {
  test('projects only trusted native balances with exact raw amount semantics', async () => {
    await expect(
      readSolanaPortfolioSource({
        chainAccount: solanaChainAccount,
        assets,
        rpc: solanaRpc(),
        now: () => 2_000
      })
    ).resolves.toEqual({
      chainAccount: solanaChainAccount,
      status: 'ready',
      balances: [
        {
          assetId: `${solanaChainId}/slip44:501`,
          totalRaw: '1234567890',
          spendableRaw: '1234567890',
          availableRaw: '1234567890',
          pendingRaw: '0',
          updatedAt: 2_000
        }
      ]
    })

    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets,
        rpc: nearRpc(),
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        {
          assetId: `${nearChainId}/slip44:397`,
          totalRaw: '120',
          spendableRaw: '100',
          availableRaw: '100',
          pendingRaw: '0',
          updatedAt: 2_000
        }
      ]
    })
  })

  test('treats an unfunded implicit NEAR account as zero and maps RPC failures without fabricating balances', async () => {
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets,
        rpc: nearRpc({ getAccount: async () => null }),
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [{ totalRaw: '0', spendableRaw: '0', availableRaw: '0' }]
    })

    await expect(
      readSolanaPortfolioSource({
        chainAccount: solanaChainAccount,
        assets,
        rpc: solanaRpc({
          assertExpectedChain: async () => {
            throw new SolanaRpcError('chain-mismatch', 'wrong chain')
          }
        })
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'invalid-response', balances: [] })

    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets,
        rpc: nearRpc({
          getAccount: async () => {
            throw new NearRpcError('rate-limited', 'limited')
          }
        })
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'rate-limited', balances: [] })
  })

  test('keeps a user-shown SPL token visible with a zero balance until a token account exists', async () => {
    let mintReads = 0
    await expect(
      readSolanaPortfolioSource({
        chainAccount: solanaChainAccount,
        assets: assetsWithSolanaUsdc,
        trackedAssetIds: new Set([`${solanaChainId}/token:${solanaUsdcMint}`]),
        rpc: solanaRpc({
          getTokenAccountsByMints: async () => {
            mintReads += 1
            throw new Error('Shown SPL tokens must not be queried by mint')
          },
          getTokenAccountsByOwner: async () => ({ contextSlot: 10, accounts: [] })
        }),
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        { assetId: `${solanaChainId}/slip44:501`, totalRaw: '1234567890' },
        {
          assetId: `${solanaChainId}/token:${solanaUsdcMint}`,
          totalRaw: '0',
          spendableRaw: '0',
          availableRaw: '0'
        }
      ]
    })
    expect(mintReads).toBe(0)
  })

  test('discovers held SPL tokens by owner and omits the rest of a large catalog', async () => {
    const extraMint = shownSolanaMint
    const catalog = createAssetRegistry(chains, [
      ...filterAssetDefinitionsForChains(
        getBundledInitialProductAssetDefinitions('testnet'),
        chains
      ),
      {
        chainId: solanaChainId,
        namespace: 'token',
        reference: solanaUsdcMint,
        kind: 'token',
        metadata: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
        source: 'protocol',
        verification: 'trusted'
      },
      ...Array.from({ length: 300 }, (_, index) => ({
        chainId: solanaChainId,
        namespace: 'token',
        reference: solanaCatalogMints[index],
        kind: 'token',
        metadata: { name: `Token ${index}`, symbol: `T${index}`, decimals: 6 },
        source: 'protocol',
        verification: 'trusted'
      })),
      {
        chainId: solanaChainId,
        namespace: 'token',
        reference: extraMint,
        kind: 'token',
        metadata: { name: 'Shown', symbol: 'SHOWN', decimals: 9 },
        source: 'protocol',
        verification: 'trusted'
      }
    ])
    let mintReads = 0
    let ownerReads = 0
    const result = await readSolanaPortfolioSource({
      chainAccount: solanaChainAccount,
      assets: catalog,
      trackedAssetIds: new Set([`${solanaChainId}/token:${extraMint}`]),
      rpc: solanaRpc({
        getTokenAccountsByMints: async () => {
          mintReads += 1
          throw new Error('Catalog mints must not be queried')
        },
        getTokenAccountsByOwner: async () => {
          ownerReads += 1
          return {
            contextSlot: 10,
            accounts:
              ownerReads === 1
                ? [
                    {
                      accountAddress: solanaAddress,
                      program: 'legacy',
                      mint: solanaUsdcMint,
                      owner: solanaAddress,
                      state: 'initialized',
                      isNative: false,
                      amountRaw: '2500000',
                      decimals: 6
                    }
                  ]
                : []
          }
        }
      }),
      now: () => 2_000
    })

    expect(mintReads).toBe(0)
    expect(ownerReads).toBe(2)
    expect(result.status).toBe('ready')
    expect(result.balances.map(balance => balance.assetId)).toEqual([
      `${solanaChainId}/slip44:501`,
      `${solanaChainId}/token:${solanaUsdcMint}`,
      `${solanaChainId}/token:${extraMint}`
    ])
    expect(result.balances[1]).toMatchObject({ totalRaw: '2500000' })
    expect(result.balances[2]).toMatchObject({ totalRaw: '0' })
  })

  test('uses the FastNear inventory for registered NEP-141 balances without per-token RPC reads', async () => {
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithNearUsdt,
        rpc: nearRpc(),
        tokenInventory: {
          getFungibleTokenBalances: async () => [
            {
              contractId: nearUsdtContract,
              amountRaw: '2500000',
              lastUpdateBlockHeight: 39
            }
          ]
        },
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        { assetId: `${nearChainId}/slip44:397`, totalRaw: '120' },
        {
          assetId: `${nearChainId}/nep141:${nearUsdtContract}`,
          totalRaw: '2500000',
          spendableRaw: '2500000',
          availableRaw: '2500000'
        }
      ]
    })
  })

  test('falls back to one NEP-141 RPC read only for a user-shown token', async () => {
    let rpcReads = 0
    const rpc = nearRpc({
      getFungibleTokenBalance: async (contractId, requestedAccountId) => {
        rpcReads += 1
        return {
          contractId,
          accountId: requestedAccountId,
          amountRaw: '7000000',
          blockHash,
          blockHeight: 40
        }
      }
    })
    const tokenInventory = {
      getFungibleTokenBalances: async () => [
        {
          contractId: nearUsdtContract,
          amountRaw: null,
          lastUpdateBlockHeight: null
        }
      ]
    }
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithNearUsdt,
        rpc,
        tokenInventory,
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      balances: [{ assetId: `${nearChainId}/slip44:397`, totalRaw: '120' }]
    })
    expect(rpcReads).toBe(0)

    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithNearUsdt,
        trackedAssetIds: new Set([`${nearChainId}/nep141:${nearUsdtContract}`]),
        rpc,
        tokenInventory,
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      balances: [
        { assetId: `${nearChainId}/slip44:397` },
        { assetId: `${nearChainId}/nep141:${nearUsdtContract}`, totalRaw: '7000000' }
      ]
    })
    expect(rpcReads).toBe(1)
  })

  test('reads a NEAR catalog above the RPC cap from FastNear without per-token RPC', async () => {
    let rpcReads = 0
    const result = await readNearPortfolioSource({
      chainAccount: nearChainAccount,
      assets: assetsWithNearCatalog(65),
      rpc: nearRpc({
        getFungibleTokenBalance: async () => {
          rpcReads += 1
          throw new Error('Indexed NEAR catalog must not query ft_balance_of')
        }
      }),
      tokenInventory: {
        getFungibleTokenBalances: async () => [
          {
            contractId: nearUsdtContract,
            amountRaw: '1153920',
            lastUpdateBlockHeight: 39
          }
        ]
      },
      now: () => 2_000
    })

    expect(result.status).toBe('ready')
    expect(result.balances).toHaveLength(2)
    expect(
      result.balances.find(balance => balance.assetId === `${nearChainId}/slip44:397`)
    ).toMatchObject({ totalRaw: '120' })
    expect(
      result.balances.find(
        balance => balance.assetId === `${nearChainId}/nep141:${nearUsdtContract}`
      )
    ).toMatchObject({
      totalRaw: '1153920',
      spendableRaw: '1153920',
      availableRaw: '1153920'
    })
    expect(
      result.balances.find(balance => balance.assetId === `${nearChainId}/nep141:token01.testnet`)
    ).toBeUndefined()
    expect(rpcReads).toBe(0)
  })

  test('keeps native NEAR available when a large catalog cannot be indexed', async () => {
    let rpcReads = 0
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithNearCatalog(300),
        rpc: nearRpc({
          getFungibleTokenBalance: async () => {
            rpcReads += 1
            throw new Error('Unavailable FastNear must not fan out ft_balance_of')
          }
        }),
        tokenInventory: {
          getFungibleTokenBalances: async () => {
            throw new Error('FastNear unavailable')
          }
        },
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [{ assetId: `${nearChainId}/slip44:397`, totalRaw: '120' }]
    })
    expect(rpcReads).toBe(0)
  })

  test('reads a saved custom NEP-141 with ft_balance_of when FastNear has not indexed it', async () => {
    const implicit = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'
    const assetsWithCustomNear = createAssetRegistry(chains, [
      ...filterAssetDefinitionsForChains(
        getBundledInitialProductAssetDefinitions('testnet'),
        chains
      ),
      {
        chainId: nearChainId,
        namespace: 'nep141',
        reference: implicit,
        kind: 'token',
        metadata: { name: 'Custom Fungible', symbol: 'CSTM', decimals: 18 },
        source: 'user-added',
        verification: 'user-approved'
      },
      {
        chainId: nearChainId,
        namespace: 'nep141',
        reference: nearUsdtContract,
        kind: 'token',
        metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
        source: 'protocol',
        verification: 'trusted'
      }
    ])
    const queried = []
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithCustomNear,
        rpc: nearRpc({
          getFungibleTokenBalance: async (contractId, requestedAccountId) => {
            queried.push(contractId)
            return {
              contractId,
              accountId: requestedAccountId,
              amountRaw: '42',
              blockHash,
              blockHeight: 40
            }
          }
        }),
        tokenInventory: {
          getFungibleTokenBalances: async () => [
            { contractId: implicit, amountRaw: '1', lastUpdateBlockHeight: 3 }
          ]
        },
        customTokens: [{ contractId: nearUsdtContract, symbol: 'USDT', decimals: 6 }],
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        { assetId: `${nearChainId}/slip44:397` },
        { assetId: `${nearChainId}/nep141:${implicit}`, totalRaw: '42' },
        { assetId: `${nearChainId}/nep141:${nearUsdtContract}`, totalRaw: '42' }
      ]
    })
    expect(queried.sort()).toEqual([implicit, nearUsdtContract].sort())
  })

  test('splits NEAR native and tracked NEP-141 balances across the main account and PEA', async () => {
    const privateAddress = 'b90b217039eed36162aef24e79ec0be08063210c65eff1a1c3d1af7c11fa8af4'
    const queried = []
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithNearUsdt,
        trackedAssetIds: new Set([`${nearChainId}/nep141:${nearUsdtContract}`]),
        privateAddress,
        rpc: nearRpc({
          getAccount: async requestedAccountId => {
            queried.push(['account', requestedAccountId])
            return {
              accountId: requestedAccountId,
              amountRaw: requestedAccountId === privateAddress ? '7' : '100',
              lockedRaw: '20',
              storageUsage: 30,
              codeHash: blockHash,
              blockHash,
              blockHeight: 40
            }
          },
          getFungibleTokenBalance: async (contractId, requestedAccountId) => ({
            contractId,
            accountId: requestedAccountId,
            amountRaw: requestedAccountId === privateAddress ? '3' : '5',
            blockHash,
            blockHeight: 40
          })
        }),
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        {
          assetId: `${nearChainId}/slip44:397`,
          totalRaw: '107',
          mainRaw: '100',
          privateRaw: '7',
          spendableRaw: '107',
          availableRaw: '107'
        },
        {
          assetId: `${nearChainId}/nep141:${nearUsdtContract}`,
          totalRaw: '8',
          mainRaw: '5',
          privateRaw: '3'
        }
      ]
    })
    expect(queried).toEqual([
      ['account', nearAddress],
      ['account', privateAddress]
    ])

    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets,
        rpc: nearRpc(),
        privateAddress: nearAddress,
        now: () => 2_000
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'unknown', balances: [] })
  })

  test('persists generation-bound cache and composes both Beta chains through the unified model', async () => {
    const records = new Map()
    const get = async (requestedGenerationId, chainAccountId) =>
      records.get(JSON.stringify([requestedGenerationId, chainAccountId])) ?? null
    const cacheRepository = {
      get,
      getForActiveChainAccount: (requestedGenerationId, chainAccount) =>
        get(requestedGenerationId, chainAccount.id),
      put: async record => {
        records.set(JSON.stringify([record.generationId, record.source.chainAccount.id]), record)
      }
    }
    const storageRepository = {
      getActivePointer: async () => pointer(),
      getSnapshot: async () => snapshot()
    }
    let solanaEnabled = true
    const solanaPortfolio = new SingleChainPortfolioCoordinator({
      storageRepository,
      cacheRepository,
      chains,
      assets,
      chainId: solanaChainId,
      family: 'solana',
      isNetworkEnabled: () => solanaEnabled,
      now: () => 2_000,
      readSource: input => readSolanaPortfolioSource({ ...input, rpc: solanaRpc() })
    })
    const nearPortfolio = new SingleChainPortfolioCoordinator({
      storageRepository,
      cacheRepository,
      chains,
      assets,
      chainId: nearChainId,
      family: 'near',
      now: () => 2_000,
      readSource: input => readNearPortfolioSource({ ...input, rpc: nearRpc() })
    })

    await expect(solanaPortfolio.readCachedActiveSource()).resolves.toMatchObject({
      generationId,
      source: { status: 'loading', balances: [] }
    })
    await expect(solanaPortfolio.refreshActiveSource()).resolves.toMatchObject({
      generationId,
      source: { status: 'ready', balances: [{ totalRaw: '1234567890' }] }
    })
    solanaEnabled = false
    await expect(solanaPortfolio.readCachedActiveSource()).resolves.toBeNull()
    await expect(solanaPortfolio.refreshActiveSource()).resolves.toBeNull()
    solanaEnabled = true
    await expect(solanaPortfolio.readCachedActiveSource()).resolves.toMatchObject({
      source: { status: 'ready', balances: [{ totalRaw: '1234567890' }] }
    })

    const model = await new UnifiedPortfolioCoordinator({
      storageRepository,
      chains,
      assets,
      solanaPortfolio,
      nearPortfolio,
      readZcashState: () => ({ balance: null, status: 'loading', updatedAt: 0 })
    }).refreshActive()

    expect(model).toMatchObject({
      status: 'ready',
      chains: [
        { chain: { family: 'solana' }, status: 'ready' },
        { chain: { family: 'near' }, status: 'ready' }
      ],
      assets: [
        { metadata: { symbol: 'SOL' }, balance: { totalRaw: '1234567890' } },
        { metadata: { symbol: 'NEAR' }, balance: { totalRaw: '120' } }
      ]
    })
  })
})
