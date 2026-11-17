import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../src/config/networks.ts'
import { listMoveAssetPickerRows } from '../../../src/popup/services/move-asset-picker.ts'

function moveAsset({ chainId, totalRaw, mainRaw, privateRaw, confidentialRaw }) {
  return {
    chain: { chain: { id: chainId, family: chainId.startsWith('solana:') ? 'solana' : 'evm' } },
    asset: {
      asset: { id: `${chainId}/slip44:501`, chainId, kind: 'native' },
      metadata: { symbol: 'SOL', decimals: 9 },
      balance: {
        totalRaw,
        ...(mainRaw === undefined ? {} : { mainRaw }),
        ...(privateRaw === undefined ? {} : { privateRaw }),
        ...(confidentialRaw === undefined ? {} : { confidentialRaw })
      }
    }
  }
}

const picker = {
  network: 'mainnet',
  prices: null,
  portfolio: null,
  managedAssets: [],
  catalogTokens: []
}

test('keeps a zero private balance selectable after the direction switch', () => {
  const asset = moveAsset({
    chainId: SOLANA_NETWORKS.mainnet.chainId,
    totalRaw: '10',
    mainRaw: '10',
    privateRaw: '0'
  })
  const rows = listMoveAssetPickerRows({
    ...picker,
    assets: [asset],
    from: 'private',
    shieldBalances: null
  })
  expect(rows.map(row => row.sourceRaw)).toEqual(['0'])
})

test('keeps a resolved shield asset with no confidential balance', () => {
  const asset = moveAsset({
    chainId: SOLANA_NETWORKS.mainnet.chainId,
    totalRaw: '10',
    mainRaw: '10',
    privateRaw: '0'
  })
  const rows = listMoveAssetPickerRows({
    ...picker,
    assets: [asset],
    from: 'shield',
    shieldBalances: []
  })
  expect(rows.map(row => row.sourceRaw)).toEqual(['0'])
})

test('hides shield assets while confidential balances are still unresolved', () => {
  const asset = moveAsset({
    chainId: 'eip155:1',
    totalRaw: '10',
    mainRaw: '10',
    privateRaw: '0',
    confidentialRaw: '0'
  })
  const rows = listMoveAssetPickerRows({
    ...picker,
    assets: [asset],
    from: 'shield',
    shieldBalances: null
  })
  expect(rows).toEqual([])
})
