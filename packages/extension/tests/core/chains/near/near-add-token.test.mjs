import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALL_CHAIN_FEATURE_FLAGS,
  DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS,
  NEAR_CHAIN_FEATURE_FLAG
} from '../../../../src/config/multichain-feature-flags.ts'
import {
  buildAddTokenNetworks,
  isAddTokenReferenceSearch
} from '../../../../src/popup/services/add-token-model.ts'

const IMPLICIT_CONTRACT = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'

describe('NEAR add-token reference search', () => {
  const near = Object.freeze({
    chainId: 'near:testnet',
    displayName: 'NEAR Testnet',
    iconChain: 'near',
    family: 'near'
  })

  it('accepts named accounts and 64-hex implicit accounts', () => {
    assert.equal(IMPLICIT_CONTRACT.length, 64)
    assert.equal(isAddTokenReferenceSearch('token.near', near), true)
    assert.equal(isAddTokenReferenceSearch('wrap.testnet', near), true)
    assert.equal(isAddTokenReferenceSearch(IMPLICIT_CONTRACT, near), true)
    assert.equal(isAddTokenReferenceSearch('alice', near), false)
    assert.equal(isAddTokenReferenceSearch(IMPLICIT_CONTRACT.toUpperCase(), near), false)
    assert.equal(isAddTokenReferenceSearch('not a contract', near), false)
  })
})

describe('add-token network list', () => {
  it('includes NEAR for the active wallet network and keeps Solana mainnet-only', () => {
    const testnet = buildAddTokenNetworks('testnet', [], ALL_CHAIN_FEATURE_FLAGS)
    assert.equal(
      testnet.some(network => network.chainId === 'near:testnet' && network.disabled !== true),
      true
    )
    assert.equal(
      testnet.some(network => network.family === 'solana'),
      false
    )

    const mainnet = buildAddTokenNetworks('mainnet', [], ALL_CHAIN_FEATURE_FLAGS)
    assert.equal(
      mainnet.some(network => network.chainId === 'near:mainnet' && network.disabled !== true),
      true
    )
    assert.equal(
      mainnet.some(network => network.family === 'solana' && network.disabled !== true),
      true
    )

    const testnetNear = buildAddTokenNetworks('testnet', [], [NEAR_CHAIN_FEATURE_FLAG])
    assert.equal(
      testnetNear.some(network => network.chainId === 'near:testnet' && network.disabled !== true),
      true
    )
    assert.equal(
      buildAddTokenNetworks('testnet', [], DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS).some(
        network => network.chainId === 'near:testnet'
      ),
      false
    )
  })
})
