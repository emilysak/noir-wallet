import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createKeyringCommandSuccess,
  parseKeyringCommand
} from '../../../../src/core/keyring/ports/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { decodeChromeRuntimeCommand } from '../../../../src/infrastructure/keyring/multichain/chrome-runtime-codec.ts'
import { NearMultichainSigningClient } from '../../../../src/infrastructure/keyring/multichain/near-signing-client.ts'

const chainId = 'near:mainnet'
const signer = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const publicKey = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25'
const blockHash = 'SysvarC1ock11111111111111111111111111111111'
const keyDomainId = parseKeyDomainId('key-domain:near-signing-test')
const binding = {
  kind: 'credential',
  keyDomainId,
  credentialGenerationId: 'credential-generation:1',
  globalUnlockEpoch: 'global-unlock:1'
}
const transaction = {
  chainId,
  accountIndex: 0,
  signerId: signer,
  receiverId: 'alice.near',
  nonce: '1',
  blockHash,
  actions: [{ type: 'transfer', depositYocto: '1' }]
}
const payload = { kind: 'near-transaction', chainId, accountIndex: 0, transaction }

function preparedValue(commandId) {
  return {
    commandId,
    chainId,
    operation: 'transaction',
    summary: {
      schema: 'near.transaction.v1',
      chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        signerId: signer,
        publicKey,
        nonce: '1',
        receiverId: 'alice.near',
        blockHash,
        actions: [{ kind: 'transfer', depositYocto: '1' }]
      }
    },
    payloadFingerprint: { algorithm: 'sha256', digestHex: '1'.repeat(64) },
    execution: { kind: 'internal' },
    expiresAt: 1_800_000_000_000
  }
}

test('uses the credential binding for NEAR transaction prepare and confirm', async () => {
  const calls = []
  const client = new NearMultichainSigningClient({
    credentials: {
      getCredentialBinding: async requested => (calls.push(['binding', requested]), binding)
    },
    now: () => 1_000,
    createCommandId: (() => {
      let index = 0
      return () => `keyring-command:test:${++index}`
    })(),
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      calls.push([command.operation, command.binding, command.payload])
      if (command.operation === 'signing.prepare') {
        return createKeyringCommandSuccess(
          command.commandId,
          preparedValue('signing-command:near:1')
        )
      }
      return createKeyringCommandSuccess(command.commandId, {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: 'AQ==' },
        transactionId: blockHash
      })
    }
  })

  const prepared = await client.prepare(keyDomainId, payload)
  expect(prepared).toMatchObject({
    commandId: 'signing-command:near:1',
    summary: { schema: 'near.transaction.v1', review: { level: 'standard' } }
  })
  await expect(
    client.confirm(keyDomainId, parseSigningCommandId('signing-command:near:1'))
  ).resolves.toEqual({
    kind: 'signed-payload',
    payload: { encoding: 'base64', value: 'AQ==' },
    transactionId: blockHash
  })
  expect(calls).toEqual([
    ['binding', keyDomainId],
    ['signing.prepare', binding, payload],
    ['binding', keyDomainId],
    ['signing.confirm', binding, { signingCommandId: 'signing-command:near:1' }]
  ])
  await client.destroy()
})

test('rejects a prepared response bound to another chain', async () => {
  const client = new NearMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:invalid-chain',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      return createKeyringCommandSuccess(command.commandId, {
        ...preparedValue('signing-command:near:invalid'),
        chainId: 'near:testnet'
      })
    }
  })

  await expect(client.prepare(keyDomainId, payload)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  })
  await client.destroy()
})

const peaAddress = 'b90b217039eed36162aef24e79ec0be08063210c65eff1a1c3d1af7c11fa8af4'
const peaPublicKey = 'ed25519:DTLGYm12WdyTMRtPRtYAhrudpDuQYvTJnfrgq3StWJfV'

test('derives a NEAR PEA and prepares the private transaction through the worker', async () => {
  const calls = []
  const client = new NearMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    ledger: {
      resolveAccount: async () => {
        throw new Error('NEAR private execution cannot use a hardware signer')
      }
    },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:near-pea',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      calls.push([command.operation, command.payload])
      if (command.operation === 'account.derive-public') {
        return createKeyringCommandSuccess(command.commandId, {
          address: peaAddress,
          publicKey: peaPublicKey,
          curve: 'ed25519',
          derivationScheme: 'pea_v2',
          parent: { accountIndex: 0 },
          family: 'near',
          addressScheme: 'near'
        })
      }
      return createKeyringCommandSuccess(
        command.commandId,
        preparedValue('signing-command:near:pea')
      )
    }
  })

  await expect(client.deriveNearPea(keyDomainId, 0)).resolves.toEqual({
    address: peaAddress,
    publicKey: peaPublicKey,
    curve: 'ed25519',
    derivationScheme: 'pea_v2',
    parent: { accountIndex: 0 }
  })
  const peaPayload = { ...payload, kind: 'pea-near-transaction' }
  await expect(client.prepare(keyDomainId, peaPayload)).resolves.toMatchObject({
    operation: 'transaction',
    summary: { schema: 'near.transaction.v1' }
  })
  expect(calls).toEqual([
    ['account.derive-public', { family: 'near-pea', accountIndex: 0 }],
    ['signing.prepare', { kind: 'pea-near-transaction', chainId, accountIndex: 0, transaction }]
  ])
  await client.destroy()
})
