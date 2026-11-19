import { test } from 'node:test'
import { expect } from '@playwright/test'

import { supportsBitcoinPrivateExecution } from '../../../../src/core/chains/bitcoin/execution-capability.ts'
import {
  bitcoinPeaRequestJson,
  parseRawBitcoinPeaAccount
} from '../../../../src/infrastructure/keyring/multichain/raw-wallet-engine.ts'

const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN_TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'
const BITCOIN_PEA = Object.freeze({
  address: 'bc1qhshj2sek7ff9e7gkhq6hsm9sdq8lr8u0dakdzc',
  publicKey: '0x0337f142f69980b7a8d7294949e02220b9f9ff98f363d247487c15518184363851',
  curve: 'secp256k1',
  derivationScheme: 'pea_v2',
  parent: Object.freeze({ accountIndex: 0 }),
  family: 'bitcoin',
  chainId: BITCOIN_MAINNET,
  addressScheme: 'bitcoin_p2wpkh',
  addressType: 'p2wpkh',
  bitcoinNetwork: 'mainnet'
})

test('builds a P2WPKH Bitcoin PEA request independent of the public script type', () => {
  expect(bitcoinPeaRequestJson(0, BITCOIN_MAINNET)).toBe(
    `{"version":2,"family":"bitcoin","parent":{"accountIndex":0},"addressType":"p2wpkh","chainId":"${BITCOIN_MAINNET}"}`
  )
  expect(bitcoinPeaRequestJson(3, BITCOIN_TESTNET)).toBe(
    `{"version":2,"family":"bitcoin","parent":{"accountIndex":3},"addressType":"p2wpkh","chainId":"${BITCOIN_TESTNET}"}`
  )
  expect(bitcoinPeaRequestJson(0, BITCOIN_MAINNET)).not.toContain('p2tr')
  expect(bitcoinPeaRequestJson(0, BITCOIN_MAINNET)).not.toContain('p2pkh')
})

test('gates Bitcoin PEA capability to software vaults and imported index 0', () => {
  expect(supportsBitcoinPrivateExecution({ kind: 'software' }, 4)).toBe(true)
  expect(supportsBitcoinPrivateExecution({ kind: 'hardware' }, 0)).toBe(false)
  expect(
    supportsBitcoinPrivateExecution(
      { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' },
      0,
      BITCOIN_MAINNET
    )
  ).toBe(true)
  expect(
    supportsBitcoinPrivateExecution(
      { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'testnet' },
      0,
      BITCOIN_TESTNET
    )
  ).toBe(true)
  expect(
    supportsBitcoinPrivateExecution(
      { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' },
      1,
      BITCOIN_MAINNET
    )
  ).toBe(false)
  expect(
    supportsBitcoinPrivateExecution(
      { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' },
      0,
      BITCOIN_TESTNET
    )
  ).toBe(false)
  expect(supportsBitcoinPrivateExecution({ kind: 'private-key', chainFamily: 'eip155' }, 0)).toBe(
    false
  )
  expect(supportsBitcoinPrivateExecution({ kind: 'private-key', chainFamily: 'solana' }, 0)).toBe(
    false
  )
  expect(supportsBitcoinPrivateExecution(null)).toBe(false)
})

test('rejects a Bitcoin PEA result whose address does not match the public key or chain', () => {
  expect(parseRawBitcoinPeaAccount(BITCOIN_PEA, 0, BITCOIN_MAINNET)).toEqual(BITCOIN_PEA)
  expect(() =>
    parseRawBitcoinPeaAccount(
      { ...BITCOIN_PEA, address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
      0,
      BITCOIN_MAINNET
    )
  ).toThrow(/Derived Bitcoin PEA account is invalid/)
  expect(() =>
    parseRawBitcoinPeaAccount(
      { ...BITCOIN_PEA, addressType: 'p2tr', addressScheme: 'bitcoin_p2tr' },
      0,
      BITCOIN_MAINNET
    )
  ).toThrow()
  expect(() =>
    parseRawBitcoinPeaAccount(
      {
        ...BITCOIN_PEA,
        chainId: BITCOIN_TESTNET,
        bitcoinNetwork: 'testnet',
        address: 'tb1qhshj2sek7ff9e7gkhq6hsm9sdq8lr8u0dakdzc'
      },
      0,
      BITCOIN_MAINNET
    )
  ).toThrow(/Derived Bitcoin PEA account is invalid/)
  expect(() => parseRawBitcoinPeaAccount(BITCOIN_PEA, 1, BITCOIN_MAINNET, true)).toThrow(
    /Derived Bitcoin PEA account is invalid/
  )
})
