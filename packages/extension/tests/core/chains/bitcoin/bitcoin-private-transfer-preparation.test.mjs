import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { address, initEccLib, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'

import { parseTransactionId } from '../../../../src/core/transactions/domain/index.ts'
import { BitcoinTransferPreparationCoordinator } from '../../../../src/infrastructure/chains/bitcoin/index.ts'
import { parsePreparedBitcoinPsbt } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-prepared-psbt-validator.ts'

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const transactionId = parseTransactionId('transaction:bitcoin:private-preparation')

function keyMaterial(digit) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = digit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const output = payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }).output
  if (!output) throw new Error('Unable to derive Bitcoin test address')
  return {
    address: address.fromOutputScript(output, networks.bitcoin),
    publicKey: `0x${publicKey.toString('hex')}`,
    script: output
  }
}

function fundingTransaction(destination, valueSats = 100_000) {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(Buffer.alloc(32), 0xffffffff)
  transaction.addOutput(destination.script, valueSats)
  return transaction
}

function utxo(transaction, valueRaw = '100000') {
  return {
    transactionId: transaction.getId(),
    outputIndex: 0,
    valueRaw,
    status: {
      confirmed: true,
      blockHeight: 900,
      blockHash: 'b'.repeat(64),
      blockTime: 1_000
    }
  }
}

function harness(options = {}) {
  const pea = options.pea ?? keyMaterial(7)
  const publicReceive = options.publicReceive ?? keyMaterial(1)
  const recipient = options.recipient ?? keyMaterial(5)
  const calls = []
  const chainAccount = {
    id: 'chain-account:bitcoin:private',
    scope: {
      keyDomainId: 'key-domain:bitcoin:private',
      accountId: 'account:bitcoin:private',
      chainId
    },
    derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
    identity: { kind: 'account-identifier', value: publicReceive.address },
    createdAt: 1_000
  }
  const transactions = new Map(
    (options.transactions ?? []).map(transaction => [transaction.getId(), transaction.toHex()])
  )
  const coordinator = new BitcoinTransferPreparationCoordinator({
    discoveryRepository: {
      get: async () => {
        calls.push('discovery')
        throw new Error('public discovery must not be selected')
      }
    },
    derivation: {
      deriveAddress: async () => {
        calls.push('derive-public')
        throw new Error('public signer must not be derived')
      }
    },
    rpc: {
      assertExpectedChain: async () => calls.push('assert-chain'),
      getTipHeight: async () => 1_000,
      getFeeEstimates: async () => ({ 6: 2 }),
      getAddressUtxos: async requested => {
        calls.push(['utxos', requested])
        if (requested !== pea.address) throw new Error('UTXO lookup left the private execution address')
        return options.utxos ?? []
      },
      getRawTransaction: async requested => {
        calls.push(['raw', requested])
        const raw = transactions.get(requested)
        if (!raw) throw new Error('missing raw transaction')
        return raw
      }
    },
    inputReservations: {
      list: async () => [],
      reserve: async input => {
        calls.push(['reserve', input.outpoints])
        return {
          schemaVersion: 1,
          chainAccount: input.chainAccount,
          accountIndex: input.accountIndex,
          addressType: input.addressType,
          transactionId: input.transactionId,
          state: 'reserved',
          outpoints: input.outpoints,
          createdAt: input.now,
          updatedAt: input.now
        }
      },
      release: async () => calls.push('release')
    },
    now: () => 3_000,
    selectChangeOutputPosition: () => 'last'
  })
  return { pea, publicReceive, recipient, calls, chainAccount, coordinator }
}

function prepareInput(testHarness, overrides = {}) {
  return {
    chainAccount: testHarness.chainAccount,
    accountIndex: 0,
    transactionId,
    recipient: testHarness.recipient.address,
    amount: { mode: 'exact', valueSats: '50000' },
    privateExecutionAddress: testHarness.pea.address,
    publicKey: testHarness.pea.publicKey,
    publicReceiveAddress: testHarness.publicReceive.address,
    ...overrides
  }
}

test('private preparation returns change to the PEA and does not spend the public address', async () => {
  const pea = keyMaterial(7)
  const publicReceive = keyMaterial(1)
  const recipient = keyMaterial(5)
  const peaFunding = fundingTransaction(pea)
  const testHarness = harness({
    pea,
    publicReceive,
    recipient,
    transactions: [peaFunding],
    utxos: [utxo(peaFunding)]
  })
  const plan = await testHarness.coordinator.preparePrivate(prepareInput(testHarness))

  expect(plan.signerAddress).toBe(pea.address)
  expect(plan.prepared.changeAddress).toBe(pea.address)
  expect(plan.selection).toMatchObject({
    selectedTotalSats: '100000',
    amountSats: '50000',
    feeSats: '284',
    changeSats: '49716'
  })
  expect(plan.selection.selectedUtxos.map(item => item.address)).toEqual([pea.address])
  expect(testHarness.calls.some(call => call === 'discovery' || call === 'derive-public')).toBe(
    false
  )
  const parsed = parsePreparedBitcoinPsbt(plan.prepared)
  const psbt = Psbt.fromBase64(parsed.prepared.psbtBase64, { network: networks.bitcoin })
  expect(psbt.data.inputs[0].bip32Derivation?.[0].path).toBe('m')
  expect(psbt.data.inputs[0].witnessUtxo?.script.equals(pea.script)).toBe(true)
  expect(psbt.data.inputs[0].witnessUtxo?.script.equals(publicReceive.script)).toBe(false)
  expect(psbt.txOutputs.some(output => output.script.equals(publicReceive.script))).toBe(false)
  expect(psbt.txOutputs[plan.prepared.changeOutputIndex].script.equals(pea.script)).toBe(true)
  expect(
    address.fromOutputScript(
      psbt.txOutputs[plan.prepared.changeOutputIndex].script,
      networks.bitcoin
    )
  ).toBe(pea.address)
})

test('private preparation rejects a public-address input', async () => {
  const pea = keyMaterial(7)
  const publicReceive = keyMaterial(1)
  const publicFunding = fundingTransaction(publicReceive)
  const peaFunding = fundingTransaction(pea)
  const testHarness = harness({
    pea,
    publicReceive,
    transactions: [publicFunding, peaFunding],
    utxos: [utxo(publicFunding), utxo(peaFunding)]
  })

  await expect(testHarness.coordinator.preparePrivate(prepareInput(testHarness))).rejects.toThrow(
    /cannot spend the public address/
  )
  expect(testHarness.calls.some(call => Array.isArray(call) && call[0] === 'reserve')).toBe(false)
  expect(testHarness.calls.some(call => call === 'discovery' || call === 'derive-public')).toBe(
    false
  )
})

test('private preparation rejects an output to the public address', async () => {
  const pea = keyMaterial(7)
  const publicReceive = keyMaterial(1)
  const peaFunding = fundingTransaction(pea)
  const testHarness = harness({
    pea,
    publicReceive,
    transactions: [peaFunding],
    utxos: [utxo(peaFunding)]
  })

  await expect(
    testHarness.coordinator.preparePrivate(
      prepareInput(testHarness, { recipient: publicReceive.address })
    )
  ).rejects.toThrow(/cannot pay the public address/)
  expect(testHarness.calls).toEqual([])
})

test('missing PEA does not select public UTXOs', async () => {
  const publicFunding = fundingTransaction(keyMaterial(1))
  const testHarness = harness({
    transactions: [publicFunding],
    utxos: [utxo(publicFunding)]
  })
  const input = prepareInput(testHarness)
  delete input.privateExecutionAddress

  await expect(testHarness.coordinator.preparePrivate(input)).rejects.toThrow(
    /Bitcoin private execution address is unavailable/
  )
  expect(testHarness.calls).toEqual([])
})
