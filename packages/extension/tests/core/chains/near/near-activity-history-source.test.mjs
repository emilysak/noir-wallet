import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_CHAIN_FEATURE_FLAG } from '../../../../src/config/multichain-feature-flags.ts'
import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import { buildActivityReadModel } from '../../../../src/core/activity/index.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { createConfiguredActivityHistorySources } from '../../../../src/infrastructure/activity/configured-history-sources.ts'
import { createNearActivityHistorySource } from '../../../../src/infrastructure/chains/near/near-activity-history-source.ts'
import { createNearTransferGraph } from '../../../../src/infrastructure/chains/near/near-transaction-graph.ts'

const scope = { keyDomainId: 'wallet-domain', accountId: 'account-1' }

test.describe('NEAR activity history source', () => {
  test('merges indexed incoming and outgoing native and token transfers', async () => {
    const requests = []
    const source = createNearActivityHistorySource({
      chainId: NEAR_NETWORKS.mainnet.chainId,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body)
        requests.push({ url, body })
        const incoming = body.direction === 'receiver'
        return new Response(
          JSON.stringify({
            resume_token: null,
            transfers: [
              {
                amount: incoming ? '2500000' : '-1000000000000000000000000',
                asset_id: incoming ? 'nep141:usdt.tether-token.near' : 'native:near',
                block_height: incoming ? '101' : '100',
                block_timestamp: incoming ? '1700000001000000000' : '1700000000000000000',
                other_account_id: incoming ? 'sender.near' : 'recipient.near',
                receipt_id: incoming ? 'receipt-in' : 'receipt-out',
                transaction_id: incoming ? 'transaction-in' : 'transaction-out',
                transfer_index: incoming ? 2 : 1
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    })

    const items = await source.readAddressActivity({ scope, address: 'alice.near' })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'rpc:near:transaction-in:2',
      status: 'final',
      completeness: 'complete',
      snapshot: {
        direction: 'incoming',
        primaryAmount: {
          assetId: `${NEAR_NETWORKS.mainnet.chainId}/nep141:usdt.tether-token.near`,
          amountRaw: '2500000'
        }
      }
    })
    expect(items[1]).toMatchObject({
      id: 'rpc:near:transaction-out:1',
      snapshot: {
        direction: 'outgoing',
        primaryAmount: {
          assetId: `${NEAR_NETWORKS.mainnet.chainId}/slip44:397`,
          amountRaw: '1000000000000000000000000'
        }
      }
    })
    expect(requests.map(request => request.body.direction)).toEqual(['receiver', 'sender'])
  })

  test('rejects malformed transfer rows atomically', async () => {
    const source = createNearActivityHistorySource({
      chainId: NEAR_NETWORKS.mainnet.chainId,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            resume_token: null,
            transfers: [
              {
                amount: '1',
                asset_id: 'native:near',
                block_height: '1',
                block_timestamp: '1',
                other_account_id: 'INVALID',
                receipt_id: 'receipt',
                transaction_id: null,
                transfer_index: 0
              }
            ]
          }),
          { status: 200 }
        )
    })

    await expect(source.readAddressActivity({ scope, address: 'alice.near' })).rejects.toThrow(
      /FastNear/
    )
  })

  test('leaves remote testnet history absent and keeps local testnet transfers', () => {
    expect(() =>
      createNearActivityHistorySource({ chainId: NEAR_NETWORKS.testnet.chainId })
    ).toThrow(/mainnet only/)

    const testnetSources = createConfiguredActivityHistorySources({
      network: 'testnet',
      enabledChainFeatureFlags: [NEAR_CHAIN_FEATURE_FLAG]
    })
    const mainnetSources = createConfiguredActivityHistorySources({
      network: 'mainnet',
      enabledChainFeatureFlags: [NEAR_CHAIN_FEATURE_FLAG]
    })
    expect(testnetSources.nearNetwork.chainId).toBe(NEAR_NETWORKS.testnet.chainId)
    expect(testnetSources.nearHistory).toBeUndefined()
    expect(mainnetSources.nearHistory).toBeDefined()

    const chains = createInitialProductChainRegistry('testnet')
    const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))
    const localScope = { keyDomainId: 'key-domain:test', accountId: 'account:test' }
    const signerId = '00'.repeat(32)
    const graph = createNearTransferGraph({
      prepared: {
        chainId: NEAR_NETWORKS.testnet.chainId,
        accountIndex: 0,
        signerId,
        publicKey: `ed25519:${'1'.repeat(32)}`,
        receiverId: 'alice.testnet',
        depositYocto: '2000000000000000000000000',
        estimatedFeeYocto: '44636512500000000000',
        maximumFeeYocto: '446365125000000000000',
        storageReserveYocto: '1000000000000000000000',
        totalRequiredYocto: '2001446365125000000000000',
        transaction: {
          chainId: NEAR_NETWORKS.testnet.chainId,
          accountIndex: 0,
          signerId,
          receiverId: 'alice.testnet',
          nonce: '42',
          blockHash: '11111111111111111111111111111111',
          actions: [{ type: 'transfer', depositYocto: '2000000000000000000000000' }]
        }
      },
      scope: localScope,
      transactionId: 'transaction:near:testnet-local',
      segmentId: 'segment:near:testnet-local',
      assets,
      createdAt: 1_700_000_000_000
    })
    const model = buildActivityReadModel({
      scope: localScope,
      localGraphs: [graph],
      supplementalItems: []
    })
    expect(model.items).toEqual([
      expect.objectContaining({
        id: graph.root.id,
        source: 'wallet-v2',
        kind: 'transfer',
        snapshot: expect.objectContaining({
          direction: 'outgoing',
          sender: { chainId: NEAR_NETWORKS.testnet.chainId, address: signerId },
          recipient: { chainId: NEAR_NETWORKS.testnet.chainId, address: 'alice.testnet' }
        })
      })
    ])
  })
})
