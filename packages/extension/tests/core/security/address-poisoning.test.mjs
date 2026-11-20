import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  addressesLookSimilar,
  assessAddressPoisoning
} from '../../../src/core/security/address-poisoning.ts'
import { BITCOIN_CHAIN_IDS, ZCASH_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'

const evm = 'eip155:1'
const wallet = `0x${'a'.repeat(40)}`
const real = `0xabcd${'1'.repeat(32)}abcd`
const lookalike = `0xabcd${'2'.repeat(32)}abcd`

function outgoing(source, recipient, overrides = {}) {
  return {
    source,
    status: 'final',
    snapshot: {
      direction: 'outgoing',
      sender: { chainId: recipient.chainId, address: wallet },
      recipient
    },
    segments: [],
    ...overrides
  }
}

test('long-address edges match only inside one address scheme', () => {
  const chain = { chainId: evm }
  assert.equal(addressesLookSimilar({ ...chain, address: real }, { ...chain, address: lookalike }), true)
  assert.equal(addressesLookSimilar({ ...chain, address: real }, { ...chain, address: real }), false)
  assert.equal(
    addressesLookSimilar(
      { ...chain, address: real },
      { ...chain, address: `0xabcd${'1'.repeat(32)}abce` }
    ),
    false
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: 'near:mainnet', address: `${'ab'.repeat(32)}` },
      { chainId: 'near:mainnet', address: `${'ab'.repeat(30)}cdcd` }
    ),
    false
  )
  const implicit = `${'ab'.repeat(30)}abcd`
  const implicitLookalike = `${'ab'.repeat(28)}1111abcd`
  assert.equal(
    addressesLookSimilar(
      { chainId: 'near:mainnet', address: implicit },
      { chainId: 'near:mainnet', address: implicitLookalike }
    ),
    true
  )
  const bitcoin = BITCOIN_CHAIN_IDS.mainnet
  assert.equal(
    addressesLookSimilar(
      { chainId: bitcoin, address: 'bc1qabcd11111111wxyz' },
      { chainId: bitcoin, address: 'bc1qabcd22222222wxyz' }
    ),
    true
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: bitcoin, address: 'bc1qabcd11111111wxyz' },
      { chainId: bitcoin, address: 'bc1pabcd11111111wxyz' }
    ),
    false
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: 'solana:mainnet', address: `1111${'a'.repeat(24)}1111` },
      { chainId: 'solana:mainnet', address: `1111${'b'.repeat(24)}1111` }
    ),
    true
  )
})

test('NEAR named accounts and Zcash transparent addresses use their own rules', () => {
  const near = 'near:mainnet'
  assert.equal(
    addressesLookSimilar(
      { chainId: near, address: 'alice.near' },
      { chainId: near, address: 'a1ice.near' }
    ),
    true
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: near, address: 'alice.near' },
      { chainId: near, address: 'alices.near' }
    ),
    true
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: near, address: 'ab.near' },
      { chainId: near, address: 'ac.near' }
    ),
    false
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: near, address: 'alice.near' },
      { chainId: near, address: 'alice.testnet' }
    ),
    false
  )
  const zcash = ZCASH_CHAIN_IDS.mainnet
  const transparent = `t1abcd${'1'.repeat(25)}wxyz`
  const transparentLookalike = `t1abcd${'2'.repeat(25)}wxyz`
  assert.equal(
    addressesLookSimilar(
      { chainId: zcash, address: transparent },
      { chainId: zcash, address: transparentLookalike }
    ),
    true
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: zcash, address: transparent },
      { chainId: zcash, address: `t3abcd${'2'.repeat(25)}wxyz` }
    ),
    false
  )
  assert.equal(
    addressesLookSimilar(
      { chainId: zcash, address: transparent },
      { chainId: zcash, address: `u1${'q'.repeat(60)}` }
    ),
    false
  )
})

test('a zero-value transferFrom lookalike warns and a signed recipient does not', () => {
  const signed = outgoing('wallet-v2', { chainId: evm, address: real })
  const planted = [{ chainId: evm, address: lookalike }]
  const input = {
    activity: [signed, outgoing('rpc', { chainId: evm, address: lookalike })],
    plantedRecipients: planted,
    contacts: []
  }
  assert.equal(assessAddressPoisoning({ ...input, candidate: { chainId: evm, address: lookalike } }), true)
  assert.equal(
    assessAddressPoisoning({
      candidate: { chainId: evm, address: lookalike },
      activity: [],
      plantedSenders: planted
    }),
    true
  )
  assert.equal(assessAddressPoisoning({ ...input, candidate: { chainId: evm, address: real } }), false)
  assert.equal(
    assessAddressPoisoning({
      candidate: { chainId: evm, address: lookalike },
      activity: [outgoing('rpc', { chainId: evm, address: lookalike })],
      plantedRecipients: planted
    }),
    true
  )
  assert.equal(
    assessAddressPoisoning({
      candidate: { chainId: evm, address: lookalike },
      activity: [
        outgoing('wallet-v2', { chainId: evm, address: real }, { status: 'signed' }),
        outgoing('wallet-v2', { chainId: evm, address: real }, {
          segments: [{ evidence: { replacementTransactionHash: `0x${'b'.repeat(64)}` } }]
        })
      ],
      plantedRecipients: []
    }),
    false
  )
  assert.equal(
    assessAddressPoisoning({
      candidate: { chainId: 'evm:all', address: lookalike },
      activity: [],
      contacts: [{ chainId: evm, address: real }]
    }),
    true
  )
  assert.equal(
    assessAddressPoisoning({
      candidate: { chainId: evm, address: lookalike },
      activity: [signed],
      plantedRecipients: planted,
      contacts: [{ chainId: 'evm:all', address: lookalike }]
    }),
    false
  )
})

test('send confirmation stays disabled until the poisoning check finishes', () => {
  const hook = readFileSync(
    new URL('../../../src/popup/services/use-address-poisoning.ts', import.meta.url),
    'utf8'
  )
  assert.match(hook, /return 'pending'/)
  assert.match(hook, /return 'unavailable'/)
  assert.match(hook, /plantedSenders: loaded\.model\.plantedSenders/)
  for (const form of [
    '../../../src/popup/components/transaction/EvmSendReviewView.tsx',
    '../../../src/popup/components/transaction/SendTransferView.tsx',
    '../../../src/popup/components/transaction/ZcashTransfer.tsx'
  ]) {
    const source = readFileSync(new URL(form, import.meta.url), 'utf8')
    assert.match(source, /addressPoisoning === 'pending'/)
    assert.match(source, /addressPoisoningNeedsCaution\(addressPoisoning\)/)
  }
})
