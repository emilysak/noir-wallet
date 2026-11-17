import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createNearCustomTokenStore } from '../../../../src/infrastructure/chains/near/near-custom-tokens.ts'

const CONTRACT = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'

function memoryStorage() {
  const values = new Map()
  return {
    async get(key) {
      return values.get(key)
    },
    async set(key, value) {
      values.set(key, value)
    }
  }
}

describe('custom NEAR token store', () => {
  it('saves a verified NEP-141 on one account and network', async () => {
    const store = createNearCustomTokenStore(memoryStorage(), 'testnet')
    const added = await store.upsert({
      walletId: 'wallet-1',
      accountId: 'account-1',
      chainId: 'near:testnet',
      contractId: CONTRACT,
      name: 'Implicit Fungible',
      symbol: 'IFT',
      decimals: 18
    })
    assert.equal(added.contractId, CONTRACT)
    assert.equal(added.hidden, false)
    assert.deepEqual(
      (await store.list({ walletId: 'wallet-1', accountId: 'account-1' })).map(
        token => token.contractId
      ),
      [CONTRACT]
    )
    assert.deepEqual(await store.list({ walletId: 'wallet-1', accountId: 'account-2' }), [])

    const hidden = await store.setHidden(
      { walletId: 'wallet-1', accountId: 'account-1', contractId: CONTRACT },
      true
    )
    assert.equal(hidden.hidden, true)
    await store.remove({ walletId: 'wallet-1', accountId: 'account-1', contractId: CONTRACT })
    assert.deepEqual(await store.list({ walletId: 'wallet-1', accountId: 'account-1' }), [])
  })

  it('rejects a token for a different NEAR network', async () => {
    const store = createNearCustomTokenStore(memoryStorage(), 'testnet')
    await assert.rejects(
      () =>
        store.upsert({
          walletId: 'wallet-1',
          accountId: 'account-1',
          chainId: 'near:mainnet',
          contractId: 'token.near',
          name: 'Token',
          symbol: 'TKN',
          decimals: 6
        }),
      /active NEAR network/
    )
  })
})
