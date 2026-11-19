import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { initEccLib, networks, payments } from 'bitcoinjs-lib'

import { BackgroundBitcoinTransferController } from '../../../../src/background/bitcoin-transfer-controller.ts'
import { BitcoinTransactionBuildError } from '../../../../src/infrastructure/chains/bitcoin/index.ts'

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const scope = {
  keyDomainId: 'key-domain:bitcoin',
  accountId: 'account:bitcoin:0',
  chainId
}

function addressFor(digit) {
  const key = Buffer.alloc(32)
  key[31] = digit
  const address = payments.p2wpkh({
    pubkey: Buffer.from(secp256k1.pointFromScalar(key, true)),
    network: networks.bitcoin
  }).address
  if (!address) throw new Error('Unable to derive Bitcoin test address')
  return address
}

function harness(options = {}) {
  const sender = addressFor(1)
  const recipient = addressFor(2)
  const chainAccount = {
    id: 'chain-account:bitcoin:0',
    scope,
    derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
    identity: { kind: 'account-identifier', value: sender },
    createdAt: 1
  }
  const context = {
    generationId: 'storage-v2-generation:1',
    chainAccount,
    accountIndex: 0,
    keyDomainSource: options.hardware
      ? {
          kind: 'hardware',
          vendor: 'keystone',
          firmwareProfile: 'multi-coin',
          capabilities: ['bitcoin', 'evm']
        }
      : { kind: 'software', mnemonicWordCount: 24 }
  }
  const discovery = {
    schemaVersion: 1,
    chainAccount,
    accountIndex: 0,
    checkpoint: {},
    observations: [],
    updatedAt: 1
  }
  const calls = []
  const graph = {
    root: { id: 'transaction:bitcoin:fixed', status: 'prepared' },
    segments: []
  }
  const signing = {
    chainId,
    operation: 'transaction',
    summary: { schema: 'bitcoin.psbt.v1' },
    payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
    expiresAt: 5_000
  }
  const preparation = {
    prepare: async input => {
      calls.push(['preparation', input])
      if (options.insufficientTypes?.includes(input.addressType)) {
        throw new BitcoinTransactionBuildError('insufficient-funds', 'Insufficient Bitcoin funds')
      }
      return {
        prepared: { marker: 'prepared' },
        signerAddress: sender,
        changeReservation: null,
        inputReservation: { marker: 'inputs' }
      }
    },
    preparePrivate: async input => {
      calls.push(['preparation.private', input])
      return {
        prepared: { marker: 'private' },
        signerAddress: options.privateAddress ?? sender,
        changeReservation: null,
        inputReservation: { marker: 'inputs' }
      }
    }
  }
  const orchestrator = {
    prepare: async input => {
      calls.push(['orchestrator.prepare', input])
      return { graph, signing }
    },
    approve: async input => ({ status: 'broadcast', graph, input }),
    getPendingApproval: async () => null,
    reject: async () => graph,
    resumeBroadcast: async () => ({ status: 'broadcast', graph }),
    getExternalSigningRequest: async input => ({ input }),
    submitExternalSignature: async input => ({ status: 'broadcast', graph, input }),
    cancelAwaitingApprovalsForScope: async () => 0,
    cancelAwaitingApprovalsExceptScope: async () => 0,
    cancelExpiredApprovalsForScope: async input => {
      calls.push(['orchestrator.expire', input])
      return 0
    },
    clearPendingTransfers: async () => 0
  }
  const controller = new BackgroundBitcoinTransferController({
    preparation,
    orchestrator,
    loadActiveContext: async () => (options.noContext ? null : context),
    scanActive: async () => {
      if (options.rejectScan) throw new Error('public discovery must not be scanned')
      return options.mismatchedDiscovery
        ? {
            ...discovery,
            chainAccount: { ...chainAccount, id: 'chain-account:bitcoin:other' }
          }
        : discovery
    },
    getAddressType: options.activeAddressType ? async () => options.activeAddressType : undefined,
    requiredConfirmations: 6,
    createId: () => 'fixed',
    ...(options.privateAddress
      ? {
          resolvePrivateExecutionAccount: async () => ({
            address: options.privateAddress,
            publicKey: `0x${'11'.repeat(33)}`
          })
        }
      : {})
  })
  return { controller, calls, recipient, chainAccount }
}

function privateIntent(testHarness) {
  return { recipient: testHarness.recipient, amount: { mode: 'exact', valueSats: '50000' } }
}

function nearIntentsQuoteBinding(testHarness) {
  return {
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'swap',
    depositAddress: testHarness.recipient,
    refundAddress: testHarness.chainAccount.identity.value,
    expiresAt: 5_000,
    origin: {
      chainId,
      assetId: `${chainId}/slip44:0`,
      protocolAssetId: 'nep141:btc.omft.near'
    },
    destination: {
      chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '100',
      minimumAmountRaw: '99'
    }
  }
}

function rheaQuoteBinding(testHarness) {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:private',
    executionId: 'execution-private',
    router: 'nearintents',
    sourceTarget: testHarness.recipient,
    sender: testHarness.chainAccount.identity.value,
    originAmountRaw: '50000',
    expiresAt: 5_000,
    isCrossChain: true,
    origin: {
      chainId,
      assetId: `${chainId}/slip44:0`,
      protocolChainId: 'btc',
      protocolAssetId: 'btc'
    },
    destination: {
      chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '100',
      minimumAmountRaw: '99'
    }
  }
}

function preparePrivate(controller, testHarness, nearIntentsBinding, rheaSwapBinding) {
  return controller.prepare(
    privateIntent(testHarness),
    nearIntentsBinding,
    'standard',
    'p2tr',
    undefined,
    rheaSwapBinding,
    'private'
  )
}

test('prepares a default BIP-84 transfer from active discovery without accepting address policy input', async () => {
  const testHarness = harness()
  const intent = {
    recipient: testHarness.recipient,
    amount: { mode: 'exact', valueSats: '50000' }
  }
  const nearIntentsBinding = {
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'swap',
    depositAddress: testHarness.recipient,
    refundAddress: testHarness.chainAccount.identity.value,
    expiresAt: 5_000,
    origin: {
      chainId,
      assetId: `${chainId}/slip44:0`,
      protocolAssetId: 'nep141:btc.omft.near'
    },
    destination: {
      chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '100',
      minimumAmountRaw: '99'
    }
  }
  const review = await testHarness.controller.prepare(intent, nearIntentsBinding, 'fast')

  expect(review).toMatchObject({
    graph: { root: { id: 'transaction:bitcoin:fixed' } },
    review: {
      chainId,
      operation: 'transaction',
      payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) }
    }
  })
  expect(testHarness.calls[0]).toEqual(['orchestrator.expire', scope])
  expect(testHarness.calls[1][1]).toMatchObject({
    chainAccount: testHarness.chainAccount,
    accountIndex: 0,
    transactionId: 'transaction:bitcoin:fixed',
    addressType: 'p2wpkh',
    recipient: testHarness.recipient,
    amount: { mode: 'exact', valueSats: '50000' },
    feeTargetBlocks: 2
  })
  expect(testHarness.calls[2][1]).toMatchObject({
    transactionId: 'transaction:bitcoin:fixed',
    segmentId: 'segment:bitcoin:fixed',
    requiredConfirmations: 6,
    signingMode: 'internal',
    nearIntentsBinding
  })
})

test('selects Keystone signing only from the active authenticated hardware source', async () => {
  const testHarness = harness({ hardware: true })
  await testHarness.controller.prepare({
    recipient: testHarness.recipient,
    amount: { mode: 'exact', valueSats: '50000' }
  })
  expect(testHarness.calls[2][1]).toMatchObject({ signingMode: 'keystone' })

  await expect(
    testHarness.controller.getExternalSigningRequest('transaction:bitcoin:fixed')
  ).resolves.toMatchObject({
    input: { scope, transactionId: 'transaction:bitcoin:fixed' }
  })
  await expect(
    testHarness.controller.submitExternalSignature(
      'transaction:bitcoin:fixed',
      'a'.repeat(64),
      'cHNidP8BAAoAAAAA'
    )
  ).resolves.toMatchObject({
    input: {
      scope,
      transactionId: 'transaction:bitcoin:fixed',
      payloadFingerprint: 'a'.repeat(64),
      signedPsbtBase64: 'cHNidP8BAAoAAAAA'
    }
  })
  await expect(
    harness().controller.getExternalSigningRequest('transaction:bitcoin:fixed')
  ).rejects.toThrow(/not a Bitcoin-capable hardware Wallet/)
})

test('spends only the selected Bitcoin account type and keeps Keystone on BIP-84', async () => {
  const preferred = harness({ activeAddressType: 'p2tr' })
  await preferred.controller.prepare({
    recipient: preferred.recipient,
    amount: { mode: 'exact', valueSats: '50000' }
  })
  expect(preferred.calls.find(call => call[0] === 'preparation')[1].addressType).toBe('p2tr')

  const software = harness()
  await software.controller.prepare(
    {
      recipient: software.recipient,
      amount: { mode: 'exact', valueSats: '50000' }
    },
    undefined,
    undefined,
    'p2sh-p2wpkh'
  )
  expect(
    software.calls.filter(call => call[0] === 'preparation').map(call => call[1].addressType)
  ).toEqual(['p2sh-p2wpkh'])

  const hardware = harness({ hardware: true })
  await expect(
    hardware.controller.prepare(
      { recipient: hardware.recipient, amount: { mode: 'max' } },
      undefined,
      undefined,
      'p2tr'
    )
  ).rejects.toThrow(/Hardware Bitcoin transfers support only the Native SegWit account/)
  expect(
    hardware.calls.filter(call => call[0] === 'preparation').map(call => call[1].addressType)
  ).toEqual([])
})

test('rejects extra intent fields and stale discovery before reserving funds', async () => {
  const invalid = harness()
  await expect(
    invalid.controller.prepare({
      recipient: invalid.recipient,
      amount: { mode: 'max' },
      addressType: 'p2tr'
    })
  ).rejects.toThrow(/intent/)
  expect(invalid.calls).toEqual([])

  const stale = harness({ mismatchedDiscovery: true })
  await expect(
    stale.controller.prepare({ recipient: stale.recipient, amount: { mode: 'max' } })
  ).rejects.toThrow(/does not match/)
  expect(stale.calls).toEqual([])
})

test('derives continuation scope from the active Account', async () => {
  const testHarness = harness()
  const submission = await testHarness.controller.approve(
    'transaction:bitcoin:fixed',
    'a'.repeat(64)
  )
  expect(submission.input).toEqual({
    scope,
    transactionId: 'transaction:bitcoin:fixed',
    payloadFingerprint: 'a'.repeat(64)
  })
  const authorizedContexts = []
  const dappSubmission = await testHarness.controller.approveForDApp(
    'transaction:bitcoin:fixed',
    'a'.repeat(64),
    async context => {
      authorizedContexts.push(context)
    }
  )
  expect(authorizedContexts).toHaveLength(1)
  expect(dappSubmission.input).toEqual(submission.input)

  const missing = harness({ noContext: true })
  await expect(
    missing.controller.approve('transaction:bitcoin:fixed', 'a'.repeat(64))
  ).rejects.toThrow(/no Bitcoin ChainAccount/)
})

test('private Bitcoin send prepares only the PEA and does not scan public discovery', async () => {
  const pea = addressFor(9)
  const testHarness = harness({ privateAddress: pea, rejectScan: true })
  await testHarness.controller.prepare(
    { recipient: testHarness.recipient, amount: { mode: 'exact', valueSats: '50000' } },
    undefined,
    'standard',
    'p2tr',
    undefined,
    undefined,
    'private'
  )

  expect(testHarness.calls.map(call => call[0])).toEqual([
    'orchestrator.expire',
    'preparation.private',
    'orchestrator.prepare'
  ])
  expect(testHarness.calls[1][1]).toMatchObject({
    privateExecutionAddress: pea,
    publicReceiveAddress: testHarness.chainAccount.identity.value,
    feeTargetBlocks: 6
  })
  expect(testHarness.calls[1][1].addressType).toBeUndefined()
  expect(testHarness.calls[2][1]).toMatchObject({
    signerAddress: pea,
    signingFamily: 'bitcoin-pea',
    signingMode: 'internal'
  })
  expect(testHarness.calls[2][1].nearIntentsBinding).toBeUndefined()
  expect(testHarness.calls[2][1].rheaSwapBinding).toBeUndefined()
})

test('private Bitcoin send stores exactly one quote binding on the PEA PSBT', async () => {
  const pea = addressFor(9)
  const nearHarness = harness({ privateAddress: pea, rejectScan: true })
  const nearBinding = nearIntentsQuoteBinding(nearHarness)
  await preparePrivate(nearHarness.controller, nearHarness, nearBinding, undefined)

  expect(nearHarness.calls.map(call => call[0])).toEqual([
    'orchestrator.expire',
    'preparation.private',
    'orchestrator.prepare'
  ])
  expect(nearHarness.calls[1][1]).toMatchObject({
    recipient: nearHarness.recipient,
    privateExecutionAddress: pea,
    publicReceiveAddress: nearHarness.chainAccount.identity.value
  })
  expect(nearHarness.calls[1][1].addressType).toBeUndefined()
  expect(nearHarness.calls[1][1].nearIntentsBinding).toBeUndefined()
  expect(nearHarness.calls[1][1].rheaSwapBinding).toBeUndefined()
  expect(nearHarness.calls[2][1]).toMatchObject({
    signerAddress: pea,
    signingFamily: 'bitcoin-pea',
    signingMode: 'internal',
    nearIntentsBinding: nearBinding
  })
  expect(nearHarness.calls[2][1].signerAddress).not.toBe(nearHarness.chainAccount.identity.value)
  expect(nearHarness.calls[2][1].rheaSwapBinding).toBeUndefined()

  const rheaHarness = harness({ privateAddress: addressFor(8), rejectScan: true })
  const rheaBinding = rheaQuoteBinding(rheaHarness)
  await preparePrivate(rheaHarness.controller, rheaHarness, undefined, rheaBinding)

  expect(rheaHarness.calls.map(call => call[0])).toEqual([
    'orchestrator.expire',
    'preparation.private',
    'orchestrator.prepare'
  ])
  expect(rheaHarness.calls[2][1]).toMatchObject({
    signerAddress: addressFor(8),
    signingFamily: 'bitcoin-pea',
    signingMode: 'internal',
    rheaSwapBinding: rheaBinding
  })
  expect(rheaHarness.calls[2][1].nearIntentsBinding).toBeUndefined()
})

test('private Bitcoin send rejects two quote bindings before preparing', async () => {
  const testHarness = harness({ privateAddress: addressFor(9), rejectScan: true })
  await expect(
    preparePrivate(
      testHarness.controller,
      testHarness,
      nearIntentsQuoteBinding(testHarness),
      rheaQuoteBinding(testHarness)
    )
  ).rejects.toThrow(/cannot bind multiple swap protocols/)
  expect(testHarness.calls).toEqual([])
})

test('missing or hardware PEA does not select a public Bitcoin spend', async () => {
  const missing = harness({ rejectScan: true })
  await expect(
    missing.controller.prepare(
      { recipient: missing.recipient, amount: { mode: 'exact', valueSats: '50000' } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'private'
    )
  ).rejects.toThrow(/Bitcoin private execution address is unavailable/)
  expect(missing.calls).toEqual([])

  const hardware = harness({
    hardware: true,
    privateAddress: addressFor(9),
    rejectScan: true
  })
  await expect(
    hardware.controller.prepare(
      { recipient: hardware.recipient, amount: { mode: 'exact', valueSats: '50000' } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'private'
    )
  ).rejects.toThrow(/Bitcoin private send is unavailable/)
  expect(hardware.calls).toEqual([])

  const missingWithQuote = harness({ rejectScan: true })
  await expect(
    preparePrivate(
      missingWithQuote.controller,
      missingWithQuote,
      nearIntentsQuoteBinding(missingWithQuote),
      undefined
    )
  ).rejects.toThrow(/Bitcoin private execution address is unavailable/)
  expect(missingWithQuote.calls).toEqual([])

  const hardwareWithQuote = harness({
    hardware: true,
    privateAddress: addressFor(9),
    rejectScan: true
  })
  await expect(
    preparePrivate(
      hardwareWithQuote.controller,
      hardwareWithQuote,
      undefined,
      rheaQuoteBinding(hardwareWithQuote)
    )
  ).rejects.toThrow(/Bitcoin private send is unavailable/)
  expect(hardwareWithQuote.calls).toEqual([])
})
