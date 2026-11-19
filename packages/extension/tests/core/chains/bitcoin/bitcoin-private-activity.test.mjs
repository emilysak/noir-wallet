import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  BITCOIN_PRIVATE_ACTIVITY_CACHE_PARTITION,
  partitionBitcoinPrivateExecutionActivity
} from '../../../../src/infrastructure/chains/bitcoin/bitcoin-private-activity.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const pea = 'bc1q-pea'
const publicAddress = 'bc1q-public'
const externalAddress = 'bc1q-external'

function item(id, sender, recipient, itemChainId = chainId, accountMode) {
  return {
    id,
    ...(accountMode ? { accountMode } : {}),
    segments: [{ target: { kind: 'onchain', chainId: itemChainId } }],
    snapshot: {
      ...(sender ? { sender: { chainId: itemChainId, address: sender } } : {}),
      ...(recipient ? { recipient: { chainId: itemChainId, address: recipient } } : {})
    }
  }
}

test('activity partition tags only the PEA', () => {
  expect(BITCOIN_PRIVATE_ACTIVITY_CACHE_PARTITION).toBe('private-execution-p2wpkh')
  expect(BITCOIN_PRIVATE_ACTIVITY_CACHE_PARTITION).not.toContain(pea)

  const items = [
    item('public-payment', publicAddress, externalAddress),
    item('pea-recipient', externalAddress, pea),
    item('pea-sender', pea, publicAddress),
    item('pea-history', undefined, undefined),
    item('mistagged', publicAddress, externalAddress, chainId, 'private'),
    item('solana-private', 'main-sol', 'pea-sol', 'solana:mainnet', 'private')
  ]
  const split = partitionBitcoinPrivateExecutionActivity(items, pea, new Set(['pea-history']))

  expect(split.privateItems.map(entry => entry.id)).toEqual([
    'pea-recipient',
    'pea-sender',
    'pea-history'
  ])
  expect(split.privateItems.every(entry => entry.accountMode === 'private')).toBe(true)
  expect(split.sharedItems.map(entry => entry.id)).toEqual([
    'public-payment',
    'mistagged',
    'solana-private'
  ])
  expect(split.sharedItems.find(entry => entry.id === 'public-payment').accountMode).toBeUndefined()
  expect(split.sharedItems.find(entry => entry.id === 'mistagged').accountMode).toBeUndefined()
  expect(split.sharedItems.find(entry => entry.id === 'solana-private').accountMode).toBe('private')

  const withoutPea = partitionBitcoinPrivateExecutionActivity(items, undefined)
  expect(withoutPea.privateItems).toEqual([])
  expect(withoutPea.sharedItems.map(entry => entry.id)).toEqual(items.map(entry => entry.id))
  expect(withoutPea.sharedItems.find(entry => entry.id === 'mistagged').accountMode).toBe('private')
})
