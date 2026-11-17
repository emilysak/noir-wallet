import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { adaptNearPreparedSigning } from '../../../../src/infrastructure/keyring/multichain/signing-adapter-near.ts'

const chainId = 'near:mainnet'
const mainAddress = '11'.repeat(32)
const peaAddress = 'b90b217039eed36162aef24e79ec0be08063210c65eff1a1c3d1af7c11fa8af4'
const peaPublicKey = 'ed25519:DTLGYm12WdyTMRtPRtYAhrudpDuQYvTJnfrgq3StWJfV'
const blockHash = 'SysvarC1ock11111111111111111111111111111111'
const commandId = parseSigningCommandId('signing-command:near:pea')
const payload = {
  kind: 'pea-near-transaction',
  chainId,
  accountIndex: 0,
  transaction: {
    chainId,
    accountIndex: 0,
    signerId: peaAddress,
    receiverId: 'alice.near',
    nonce: '1',
    blockHash,
    actions: [{ type: 'transfer', depositYocto: '1' }]
  }
}
const binding = {
  expectedAddress: peaAddress,
  expectedPublicKey: peaPublicKey,
  mainAddress
}

function prepared(address = peaAddress, publicKey = peaPublicKey) {
  return {
    requestId: 1,
    transactionHash: blockHash,
    account: {
      accountId: `${chainId}:${address}`,
      address,
      derivationPath: 'm',
      publicKey,
      curve: 'ed25519',
      addressScheme: 'near',
      derivationScheme: 'imported'
    },
    summary: {
      chainId,
      signerId: address,
      receiverId: 'alice.near',
      signingPublicKey: publicKey,
      signingImplicitAccountId: address,
      accountKeyBinding: 'implicit',
      nonce: '1',
      blockHash,
      transactionHash: blockHash,
      totalDepositYocto: '1',
      actions: [{ type: 'transfer', depositYocto: '1' }]
    }
  }
}

test('binds a prepared NEAR PEA signer to the derived implicit account', async () => {
  const adapted = await adaptNearPreparedSigning(
    prepared(),
    payload,
    commandId,
    Date.now() + 60_000,
    false,
    binding
  )
  expect(adapted.kind).toBe('pea-near-transaction')
  expect(adapted.account.address).toBe(peaAddress)
  expect(adapted.prepared.summary.fields.signerId).toBe(peaAddress)
  expect(adapted.prepared.summary.fields.publicKey).toBe(peaPublicKey)

  await expect(
    adaptNearPreparedSigning(
      prepared(),
      payload,
      commandId,
      Date.now() + 60_000,
      false,
      { ...binding, mainAddress: peaAddress }
    )
  ).rejects.toThrow(/parent account/)

  await expect(
    adaptNearPreparedSigning(prepared(), payload, commandId, Date.now() + 60_000, false)
  ).rejects.toThrow(/binding is missing/)
})
