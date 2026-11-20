import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CONSTRAINT_EXECUTION_MESSAGES,
  assertBitcoinSelectionWithinConstraint,
  assertWithinConstraintBinding
} from '../../../src/core/transactions/domain/execution-binding.ts'

const describe = it.describe

const binding = {
  kind: 'constraint',
  maxSpend: { assetId: 'bip122:000000000019d6689c085ae165831e93/slip44:0', amountRaw: '100000' },
  recipients: [
    {
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      address: 'bc1qrecipient'
    }
  ],
  maxFee: { assetId: 'bip122:000000000019d6689c085ae165831e93/slip44:0', amountRaw: '2000' },
  expiresAt: 2_000
}

function observed(overrides = {}) {
  return {
    spend: { assetId: binding.maxSpend.assetId, amountRaw: '100000' },
    recipients: binding.recipients,
    fee: { assetId: binding.maxFee.assetId, amountRaw: '2000' },
    ...overrides
  }
}

describe('constraint execution binding', () => {
  it('rejects spend, recipient, fee, and expiry outside the review', () => {
    assert.throws(
      () =>
        assertWithinConstraintBinding(
          binding,
          observed({ spend: { ...binding.maxSpend, amountRaw: '100001' } }),
          1_000
        ),
      error => error instanceof Error && error.message === CONSTRAINT_EXECUTION_MESSAGES.spend
    )
    assert.throws(
      () =>
        assertWithinConstraintBinding(
          binding,
          observed({
            recipients: [{ chainId: binding.recipients[0].chainId, address: 'bc1qother' }]
          }),
          1_000
        ),
      error => error instanceof Error && error.message === CONSTRAINT_EXECUTION_MESSAGES.recipient
    )
    assert.throws(
      () =>
        assertWithinConstraintBinding(
          binding,
          observed({ fee: { ...binding.maxFee, amountRaw: '2001' } }),
          1_000
        ),
      error => error instanceof Error && error.message === CONSTRAINT_EXECUTION_MESSAGES.fee
    )
    assert.throws(
      () => assertWithinConstraintBinding(binding, observed(), binding.expiresAt),
      error => error instanceof Error && error.message === CONSTRAINT_EXECUTION_MESSAGES.expired
    )
  })

  it('accepts a lower fee and a Bitcoin reselection whose change stays out of the recipient set', () => {
    assert.doesNotThrow(() =>
      assertWithinConstraintBinding(
        binding,
        observed({ fee: { ...binding.maxFee, amountRaw: '1500' } }),
        1_000
      )
    )
    assert.doesNotThrow(() =>
      assertBitcoinSelectionWithinConstraint({
        binding,
        chainId: binding.recipients[0].chainId,
        assetId: binding.maxSpend.assetId,
        recipient: binding.recipients[0].address,
        amountSats: '90000',
        feeSats: '1800',
        now: 1_000
      })
    )
    assert.throws(
      () =>
        assertWithinConstraintBinding(
          binding,
          observed({
            recipients: [
              binding.recipients[0],
              { chainId: binding.recipients[0].chainId, address: 'bc1qchange' }
            ]
          }),
          1_000
        ),
      error => error instanceof Error && error.message === CONSTRAINT_EXECUTION_MESSAGES.recipient
    )
  })

  it('keeps dApp PSBT signing bound to the reviewed payload fingerprint', () => {
    const source = readFileSync(
      new URL('../../../src/background/bitcoin-dapp-handler.ts', import.meta.url),
      'utf8'
    )
    const signPsbt = source.slice(
      source.indexOf('private async signPsbt'),
      source.indexOf('private async signPsbts')
    )
    assert.match(signPsbt, /psbt: bytesToBase64\(hexToBytes\(parsed\.psbtHex\)\)/)
    assert.match(signPsbt, /this\.confirmSigning\(/)
    assert.doesNotMatch(signPsbt, /reselectIfInputsUnavailable|reselectWalletInputs/)
  })
})
