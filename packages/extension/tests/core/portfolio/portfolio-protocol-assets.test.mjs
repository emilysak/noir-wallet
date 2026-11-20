import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  selectManagedProtocolAssetIds,
  selectPortfolioProtocolDefinitions,
  selectPricedProtocolMappings
} from '../../../src/core/portfolio/portfolio-protocol-assets.ts'

const solanaChainId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const nearChainId = 'near:mainnet'

function protocolToken(chainId, namespace, reference) {
  return Object.freeze({
    chainId,
    namespace,
    reference,
    kind: 'token',
    metadata: { name: reference, symbol: reference.slice(0, 8), decimals: 6 },
    source: 'protocol',
    verification: 'trusted'
  })
}

test('portfolio protocol definitions follow the displayed model instead of the catalog', () => {
  const definitions = Array.from({ length: 4_089 }, (_, index) =>
    index < 3_878
      ? protocolToken(solanaChainId, 'token', `mint-${index}`)
      : protocolToken(nearChainId, 'nep141', `token${index}.near`)
  )
  const heldId = `${solanaChainId}/token:mint-10`
  const visibleId = `${nearChainId}/nep141:token4000.near`
  const bundledId = `${solanaChainId}/token:mint-11`
  const selected = selectPortfolioProtocolDefinitions({
    assetIds: new Set([heldId, visibleId, bundledId, `${solanaChainId}/slip44:501`]),
    knownAssetIds: new Set([bundledId]),
    definitions
  })

  expect(
    selected.map(
      definition => `${definition.chainId}/${definition.namespace}:${definition.reference}`
    )
  ).toEqual([heldId, visibleId])
})

test('managed protocol ids keep holdings and user-shown tokens', () => {
  const protocolAssetIds = Array.from({ length: 4_089 }, (_, index) => `asset:${index}`)
  const selected = selectManagedProtocolAssetIds({
    protocolAssetIds,
    heldAssetIds: new Set(['asset:3']),
    visibleAssetIds: new Set(['asset:9'])
  })

  expect(selected).toEqual(['asset:3', 'asset:9'])
})

test('priced protocol mappings prefer visible assets and stay inside the budget', () => {
  const mappings = Array.from({ length: 4_089 }, (_, index) =>
    Object.freeze({
      assetId: `asset:${index}`,
      marketAssetId: 'intents-asset',
      sourceAssetId: `nep141:t${index}.near`
    })
  )
  const selected = selectPricedProtocolMappings({
    mappings,
    visibleAssetIds: new Set(['asset:9']),
    heldAssetIds: new Set(['asset:3', 'asset:9']),
    maximum: 2_048
  })

  expect(selected.map(mapping => mapping.assetId)).toEqual(['asset:9', 'asset:3'])

  const capped = selectPricedProtocolMappings({
    mappings,
    visibleAssetIds: new Set(['asset:9']),
    heldAssetIds: new Set(['asset:3']),
    maximum: 1
  })
  expect(capped.map(mapping => mapping.assetId)).toEqual(['asset:9'])
  expect(
    selectPricedProtocolMappings({
      mappings,
      visibleAssetIds: new Set(['asset:9']),
      heldAssetIds: new Set(['asset:3']),
      maximum: 0
    })
  ).toEqual([])
})
