import { test } from 'node:test'
import { expect } from '@playwright/test'

import { nearPublicKeyFromImplicitAccountId } from '../../../../src/core/chains/near/identifiers.ts'
import {
  createKeyringCommandSuccess,
  parseKeyringCommand
} from '../../../../src/core/keyring/ports/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { NearFullAccessKeyDeletionRefused } from '../../../../src/infrastructure/chains/near/near-full-access-key-removal.ts'
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

function memoryRemovalStore() {
  const intents = new Map()
  const removals = []
  return {
    removals,
    saveIntent: async (commandId, intent) => {
      intents.set(commandId, intent)
    },
    readIntent: async commandId => intents.get(commandId) ?? null,
    deleteIntent: async commandId => {
      intents.delete(commandId)
    },
    recordRemoval: async record => {
      removals.push(record)
    }
  }
}

test('checks a full-access key deletion before prepare and confirm, then records it', async () => {
  const deleted = nearPublicKeyFromImplicitAccountId('00'.repeat(32))
  const retained = nearPublicKeyFromImplicitAccountId('11'.repeat(32))
  const calls = []
  const store = memoryRemovalStore()
  const client = new NearMultichainSigningClient({
    credentials: {
      getCredentialBinding: async requested => (calls.push(['binding', requested]), binding)
    },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:delete-key',
    fullAccessKeyRemovals: store,
    onFullAccessKeyRemovalRecorded: async () => {
      calls.push(['recorded'])
    },
    authorizeFullAccessKeyDeletion: async input => {
      calls.push(['authorize', input.deletedPublicKeys])
      return {
        chainId,
        signerId: signer,
        deletedPublicKeys: input.deletedPublicKeys,
        retainedPublicKey: retained
      }
    },
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      calls.push([command.operation])
      if (command.operation === 'signing.prepare') {
        return createKeyringCommandSuccess(
          command.commandId,
          preparedValue('signing-command:near:delete')
        )
      }
      return createKeyringCommandSuccess(command.commandId, {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: 'AQ==' },
        transactionId: blockHash
      })
    }
  })
  const deletePayload = {
    ...payload,
    transaction: {
      ...transaction,
      actions: [{ type: 'deleteKey', publicKey: deleted }]
    }
  }

  const prepared = await client.prepare(keyDomainId, deletePayload)
  await client.confirm(keyDomainId, prepared.commandId)
  expect(calls.map(call => call[0])).toEqual([
    'authorize',
    'binding',
    'signing.prepare',
    'authorize',
    'binding',
    'signing.confirm',
    'recorded'
  ])
  expect(store.removals).toEqual([
    {
      chainId,
      transactionId: blockHash,
      signerId: signer,
      deletedPublicKey: deleted,
      retainedPublicKey: retained,
      recordedAt: 1_000
    }
  ])
  await client.destroy()
})

test('refuses a full-access key deletion before the signer prepares it', async () => {
  const calls = []
  const client = new NearMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    now: () => 1_000,
    forward: async () => {
      calls.push('forward')
      throw new Error('signer should not be called')
    }
  })
  await expect(
    client.prepare(keyDomainId, {
      ...payload,
      transaction: {
        ...transaction,
        actions: [
          { type: 'deleteKey', publicKey: nearPublicKeyFromImplicitAccountId('00'.repeat(32)) }
        ]
      }
    })
  ).rejects.toThrow(NearFullAccessKeyDeletionRefused)
  expect(calls).toEqual([])
  await client.destroy()
})
