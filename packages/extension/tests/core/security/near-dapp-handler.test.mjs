import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundNearDAppHandler } from '../../../src/background/near-dapp-handler.ts'
import { MAX_NEAR_INTENTS_JSON_DEPTH } from '../../../src/core/dapp/internal-signature-domains.ts'
import { parseSigningCommandId } from '../../../src/core/keyring/ports/signing.ts'
import { adaptNearPreparedSigning } from '../../../src/infrastructure/keyring/multichain/signing-adapter-near.ts'

const chainId = 'near:testnet'
const address = 'alice.testnet'
const publicKey = `ed25519:${'1'.repeat(32)}`

function harness({ approved = true, accessKey, preparedMessageFields } = {}) {
  const calls = []
  const analyticsEvents = []
  let authorized = true
  const active = {
    context: {
      chainAccount: {
        id: 'chain-account:near:test',
        scope: { keyDomainId: 'key-domain:near:test', accountId: 'account:test', chainId },
        identity: { kind: 'account-identifier', value: address }
      },
      accountIndex: 0,
      publicKey,
      keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
    },
    reference: { walletId: 'key-domain:near:test', accountId: 'account:test' },
    address
  }
  const signer = {
    async prepare(keyDomainId, payload) {
      calls.push(['prepare', keyDomainId, payload])
      const message = payload.kind === 'near-nep413-message'
      return {
        commandId: `signing-command:near:${message ? 'message' : 'transaction'}:${calls.length}`,
        chainId,
        operation: message ? 'message' : 'transaction',
        summary: message
          ? {
              schema: 'near.nep413-message.v1',
              fields: {
                signerId: address,
                publicKey,
                recipient: payload.request.recipient,
                nonceBase64: Buffer.from(payload.request.nonce).toString('base64'),
                callbackUrl: payload.request.callbackUrl,
                message: {
                  encoding: 'utf8',
                  value: payload.request.message,
                  byteLength: Buffer.byteLength(payload.request.message, 'utf8'),
                  sha256: '00'.repeat(32)
                },
                ...preparedMessageFields
              }
            }
          : { schema: 'near.transaction.v1', fields: { signerId: address } },
        payloadFingerprint: { algorithm: 'sha256', digestHex: '11'.repeat(32) },
        execution: { kind: 'internal' },
        expiresAt: Date.now() + 60_000
      }
    },
    async confirm(keyDomainId, commandId) {
      calls.push(['confirm', keyDomainId, commandId])
      return commandId.includes(':message:')
        ? {
            kind: 'signature',
            signature: { encoding: 'base64', value: 'AA==' },
            publicKey: 'ed25519:key',
            address
          }
        : {
            kind: 'signed-payload',
            payload: { encoding: 'base64', value: 'Ag==' },
            transactionId: 'hash'
          }
    },
    async cancel(keyDomainId, commandId) {
      calls.push(['cancel', keyDomainId, commandId])
    }
  }
  const handler = new BackgroundNearDAppHandler({
    analytics: (name, options) => analyticsEvents.push({ name, options }),
    native: {
      async request(request) {
        calls.push(['native', request])
        return 'native-result'
      },
      async notifyAccountsChanged() {}
    },
    network: { chainId, displayName: 'NEAR Testnet' },
    loadAuthorizedAccount: async () => {
      if (!authorized) throw new Error('Site connection was revoked')
      return active
    },
    requestApproval: async (_origin, action, data) => {
      calls.push(['approval', action, data])
      return { approved, requestId: 'approval:1' }
    },
    runActiveOperation: operation => operation(),
    signer,
    rpc: {
      async assertExpectedChain() {
        calls.push(['attest'])
      },
      async getAccessKey(accountId, key) {
        calls.push(['accessKey', accountId, key])
        if (accessKey) return accessKey(accountId, key)
        return {
          nonce: '7',
          blockHash: '11111111111111111111111111111111',
          permission: { kind: 'full-access' }
        }
      },
      async broadcastSignedTransactionAndWait(transaction) {
        calls.push(['broadcast', transaction])
        return { transaction: { hash: 'hash' }, status: { SuccessValue: '' } }
      }
    }
  })
  return { handler, calls, analyticsEvents, signer, revoke: () => (authorized = false) }
}

test('signs an OKX-compatible NEAR function-call transaction without broadcasting it', async () => {
  const state = harness()
  await expect(
    state.handler.request(
      {
        method: 'signTransaction',
        params: [
          {
            receiverId: 'contract.testnet',
            actions: [{ methodName: 'ping', args: { value: '1' }, gas: '1', deposit: '0' }]
          }
        ]
      },
      'https://dapp.example',
      { pageUrl: 'https://dapp.example/sign' }
    )
  ).resolves.toBe('Ag==')
  const payload = state.calls.find(call => call[0] === 'prepare')[2]
  expect(state.calls.find(call => call[0] === 'approval')[2]).toMatchObject({
    faviconPageUrl: 'https://dapp.example/sign'
  })
  expect(payload.transaction).toMatchObject({ nonce: '8', receiverId: 'contract.testnet' })
  expect(state.calls.find(call => call[0] === 'accessKey')).toEqual([
    'accessKey',
    address,
    publicKey
  ])
  expect(payload.transaction.actions[0]).toMatchObject({
    type: 'functionCall',
    methodName: 'ping',
    gas: '1',
    depositYocto: '0'
  })
  expect(state.calls.some(call => call[0] === 'broadcast')).toBe(false)
})

test('signs a Wallet Selector transfer action without exposing a fixed transfer RPC', async () => {
  const state = harness()
  await expect(
    state.handler.request(
      {
        method: 'signTransaction',
        params: [
          {
            receiverId: 'recipient.testnet',
            actions: [{ type: 'Transfer', params: { deposit: '1' } }]
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toBe('Ag==')
  const payload = state.calls.find(call => call[0] === 'prepare')[2]
  expect(payload.transaction.actions).toEqual([{ type: 'transfer', depositYocto: '1' }])
  expect(payload.source).toBe('dapp')
})

test('signs and broadcasts a Near Connect transaction after approval', async () => {
  const state = harness()
  await expect(
    state.handler.request(
      {
        method: 'signAndSendTransaction',
        params: [
          {
            signerId: address,
            receiverId: 'contract.testnet',
            actions: [
              {
                enum: 'functionCall',
                functionCall: {
                  methodName: 'stake',
                  args: [123, 125],
                  gas: '300000000000000',
                  deposit: '0'
                }
              }
            ]
          }
        ]
      },
      'https://x.rhea.finance',
      {}
    )
  ).resolves.toEqual({ transaction: { hash: 'hash' }, status: { SuccessValue: '' } })
  expect(state.calls.filter(call => call[0] === 'broadcast')).toEqual([['broadcast', 'Ag==']])
  expect(state.calls.find(call => call[0] === 'prepare')[2].transaction.actions[0]).toMatchObject({
    args: 'e30=',
    gas: '300000000000000',
    depositYocto: '0'
  })
})

test('does not broadcast a signed NEAR transaction after site authorization is revoked', async () => {
  const state = harness()
  const confirm = state.signer.confirm
  state.signer.confirm = async (...args) => {
    const result = await confirm(...args)
    state.revoke()
    return result
  }
  await expect(
    state.handler.request(
      {
        method: 'signAndSendTransaction',
        params: [
          {
            receiverId: 'recipient.testnet',
            actions: [{ type: 'Transfer', params: { deposit: '1' } }]
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toThrow('Site connection was revoked')
  expect(state.calls.some(call => call[0] === 'broadcast')).toBe(false)
})

test('allocates consecutive nonces for a NEAR transaction batch', async () => {
  const state = harness()
  await expect(
    state.handler.request(
      {
        method: 'requestSignTransactions',
        params: [
          {
            transactions: [
              {
                receiverId: 'one.testnet',
                actions: [{ methodName: 'one', args: {}, gas: '1', deposit: '0' }]
              },
              {
                receiverId: 'two.testnet',
                actions: [{ methodName: 'two', args: {}, gas: '2', deposit: '0' }]
              }
            ]
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toEqual({ txs: [{ signedTx: 'Ag==' }, { signedTx: 'Ag==' }] })
  expect(
    state.calls.filter(call => call[0] === 'prepare').map(call => call[2].transaction.nonce)
  ).toEqual(['8', '9'])
})

test('signs a NEP-413 message through the message approval path', async () => {
  const state = harness()
  await expect(
    state.handler.request(
      {
        method: 'signMessage',
        params: [
          {
            message: 'hello',
            recipient: 'dapp.testnet',
            nonce: Array(32).fill(1),
            callbackUrl: null,
            state: 'state'
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toEqual({
    accountId: address,
    publicKey: 'ed25519:key',
    signature: 'AA==',
    state: 'state'
  })
  expect(state.calls.find(call => call[0] === 'approval')[1]).toBe('nearMessage')
})

test('rejects NEAR message signatures that hit an internal signature domain before approval', async () => {
  const state = harness()
  const nonce = Array(32).fill(1)
  const base = {
    message: 'hello',
    recipient: 'dapp.testnet',
    nonce,
    callbackUrl: null,
    state: null
  }
  let deep = '{"verifying_contract":"\\u0069ntents.near"}'
  for (let layer = 1; layer < MAX_NEAR_INTENTS_JSON_DEPTH + 1; layer += 1) {
    deep = JSON.stringify({ note: deep })
  }
  const requests = [
    { ...base, recipient: 'intents.near' },
    { ...base, recipient: 'intents.far' },
    {
      ...base,
      message: JSON.stringify({
        signer_id: 'alice.testnet',
        intents: [],
        nonce: 'n',
        deadline: 'd'
      })
    },
    {
      ...base,
      message: JSON.stringify({ note: ' {"verifying_contract":"\\u0069ntents.near"} ' })
    },
    { ...base, message: deep },
    { ...base, callbackUrl: 'https://intents.near/callback' }
  ]
  for (const request of requests) {
    await expect(
      state.handler.request(
        { method: 'signMessage', params: [request] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({
      code: 4200,
      message: 'Noir Wallet rejected this NEAR Intents signature request.'
    })
  }
  expect(state.calls).toEqual([])
  expect(state.analyticsEvents.map(event => event.name)).not.toContain('dapp_request_rejected')
})

test('rejects a prepared NEP-413 summary that changes signed fields before approval', async () => {
  const request = {
    message: 'hello',
    recipient: 'dapp.testnet',
    nonce: Array(32).fill(1),
    callbackUrl: null,
    state: null
  }
  for (const preparedMessageFields of [
    { recipient: 'other.testnet' },
    { nonceBase64: Buffer.from(Array(32).fill(2)).toString('base64') },
    { message: { encoding: 'utf8', value: 'different', byteLength: 9 } },
    { callbackUrl: 'https://other.example' }
  ]) {
    const state = harness({ preparedMessageFields })
    await expect(
      state.handler.request({ method: 'signMessage', params: [request] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
  }
  const internal = harness({ preparedMessageFields: { recipient: 'intents.near' } })
  await expect(
    internal.handler.request({ method: 'signMessage', params: [request] }, 'https://dapp.example', {})
  ).rejects.toMatchObject({
    code: 4200,
    message: 'Noir Wallet rejected this NEAR Intents signature request.'
  })
  expect(internal.calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})

test('signs a NEAR message when only the unsigned state mentions an internal domain', async () => {
  const state = harness()
  await expect(
    state.handler.request(
      {
        method: 'signMessage',
        params: [
          {
            message: 'hello',
            recipient: 'app.intents.near',
            nonce: Array(32).fill(1),
            callbackUrl: null,
            state: 'intents.near'
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toMatchObject({ accountId: address, signature: 'AA==', state: 'intents.near' })
  expect(state.calls.find(call => call[0] === 'approval')[1]).toBe('nearMessage')
})

test('analytics separates NEAR signing, user cancellation and approved broadcast failures', async () => {
  const request = {
    method: 'signAndSendTransaction',
    params: [
      { receiverId: 'recipient.testnet', actions: [{ type: 'Transfer', params: { deposit: '1' } }] }
    ]
  }
  const signedOnly = harness()
  await signedOnly.handler.request(
    { ...request, method: 'signTransaction' },
    'https://dapp.example',
    {}
  )
  expect(signedOnly.analyticsEvents).toEqual([])
  const rejected = harness({ approved: false })
  await expect(rejected.handler.request(request, 'https://dapp.example', {})).rejects.toMatchObject(
    { code: 4001 }
  )
  expect(rejected.analyticsEvents.map(event => event.name)).toEqual(['dapp_request_rejected'])
  const failed = harness()
  failed.signer.confirm = async () => {
    throw new Error('private signing failure')
  }
  await expect(failed.handler.request(request, 'https://dapp.example', {})).rejects.toThrow()
  expect(failed.analyticsEvents.map(event => event.name)).toEqual(['dapp_transaction_failed'])
  const sent = harness()
  await sent.handler.request(request, 'https://dapp.example', {})
  expect(sent.analyticsEvents.map(event => event.name)).toEqual(['dapp_transaction_sent'])
  expect(sent.analyticsEvents[0].options).toMatchObject({
    chain: 'near',
    pageId: 'noir_dapp',
    hasTransaction: 1
  })
  expect(JSON.stringify([...failed.analyticsEvents, ...sent.analyticsEvents])).not.toMatch(
    /private signing|dapp.example/
  )
})

async function expectBlockedNearAction(
  params,
  message,
  { accessKey, method = 'signTransaction' } = {}
) {
  const state = harness(accessKey ? { accessKey } : {})
  await expect(
    state.handler.request({ method, params }, 'https://dapp.example', {})
  ).rejects.toMatchObject({ code: 4200, message })
  expect(state.calls.some(call => call[0] === 'prepare' || call[0] === 'approval')).toBe(false)
  return state
}

test('hard-blocks NEAR dApp actions that can take over or destroy the account', async () => {
  const otherKey = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25'
  const fullAccessKey = {
    type: 'AddKey',
    params: { publicKey: otherKey, accessKey: { nonce: 0, permission: 'FullAccess' } }
  }
  await expectBlockedNearAction([{ receiverId: 'contract.testnet', actions: [fullAccessKey] }], 'NEAR dApp requests cannot add a full-access key.')
  await expectBlockedNearAction(
    [
      {
        receiverId: 'contract.testnet',
        actions: [
          {
            enum: 'addKey',
            addKey: { publicKey: otherKey, accessKey: { permission: { enum: 'fullAccess' } } }
          }
        ]
      }
    ],
    'NEAR dApp requests cannot add a full-access key.'
  )
  await expectBlockedNearAction(
    [
      {
        receiverId: address,
        actions: [{ type: 'DeleteKey', params: { publicKey } }]
      }
    ],
    'NEAR dApp requests cannot delete an access key.'
  )
  const fullAccessDelete = await expectBlockedNearAction(
    [
      {
        receiverId: address,
        actions: [{ enum: 'deleteKey', deleteKey: { publicKey: otherKey } }]
      }
    ],
    'NEAR dApp requests cannot delete an access key.'
  )
  expect(fullAccessDelete.calls.some(call => call[0] === 'accessKey')).toBe(false)
  await expectBlockedNearAction(
    [
      {
        receiverId: address,
        actions: [{ type: 'DeleteAccount', params: { beneficiaryId: 'bob.testnet' } }]
      }
    ],
    'NEAR dApp requests cannot delete this account.'
  )
  await expectBlockedNearAction(
    [
      {
        receiverId: address,
        actions: [{ enum: 'deployContract', deployContract: { code: [1, 2, 3] } }]
      }
    ],
    'NEAR dApp requests cannot deploy a contract to this account.'
  )
  await expectBlockedNearAction(
    [
      {
        receiverId: 'contract.testnet',
        actions: [{ type: 'Stake', params: { stake: '1', publicKey: otherKey } }]
      }
    ],
    'NEAR dApp requests cannot stake.'
  )
  await expectBlockedNearAction(
    [
      {
        transactions: [
          {
            receiverId: 'one.testnet',
            actions: [{ methodName: 'one', args: {}, gas: '1', deposit: '0' }]
          },
          {
            receiverId: 'two.testnet',
            actions: [{ enum: 'stake', stake: { stake: '1', publicKey: otherKey } }]
          }
        ]
      }
    ],
    'NEAR dApp requests cannot stake.',
    { method: 'signAndSendTransactions' }
  )
  await expectBlockedNearAction(
    [
      {
        receiverId: 'contract.testnet',
        actions: [{ enum: 'signedDelegate', signedDelegate: { delegateAction: { actions: [] } } }]
      }
    ],
    'Noir Wallet does not support NEAR delegate actions.'
  )
})

test('rejects every NEAR dApp DeleteKey before RPC, parsing, approval or signing', async () => {
  const otherKey = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25'
  const limited = harness({
    accessKey: () => ({
      nonce: '1',
      blockHash: '11111111111111111111111111111111',
      permission: {
        kind: 'function-call',
        allowanceRaw: null,
        receiverId: 'app.testnet',
        methodNames: []
      }
    })
  })
  await expect(
    limited.handler.request(
      {
        method: 'signTransaction',
        params: [
          {
            receiverId: address,
            actions: [{ type: 'DeleteKey', params: { publicKey: otherKey } }]
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({
    code: 4200,
    message: 'NEAR dApp requests cannot delete an access key.'
  })
  expect(limited.calls).toEqual([])

  const unavailable = harness({
    accessKey: () => {
      throw new Error('rpc unavailable')
    }
  })
  await expect(
    unavailable.handler.request(
      {
        method: 'signTransaction',
        params: [
          {
            receiverId: address,
            actions: [{ type: 'DeleteKey', params: { publicKey: otherKey } }]
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({
    code: 4200,
    message: 'NEAR dApp requests cannot delete an access key.'
  })
  expect(unavailable.calls).toEqual([])

  await expectBlockedNearAction(
    [{ receiverId: address, actions: [{ type: 'DeleteKey', params: {} }] }],
    'NEAR dApp requests cannot delete an access key.'
  )
  const batch = await expectBlockedNearAction(
    [
      {
        transactions: [
          {
            receiverId: 'contract.testnet',
            actions: [{ type: 'Transfer', params: { deposit: '1' } }]
          },
          {
            receiverId: address,
            actions: [{ enum: 'deleteKey', deleteKey: { publicKey: otherKey } }]
          }
        ]
      }
    ],
    'NEAR dApp requests cannot delete an access key.',
    { method: 'signAndSendTransactions' }
  )
  expect(batch.calls).toEqual([])
})

test('does not classify other-account deploy or limited-key addition as account takeover', async () => {
  const otherKey = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25'
  const otherDeploy = harness()
  await expect(
    otherDeploy.handler.request(
      {
        method: 'signTransaction',
        params: [
          {
            receiverId: 'contract.testnet',
            actions: [{ type: 'DeployContract', params: { code: [1] } }]
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: -32602 })
  expect(otherDeploy.calls.some(call => call[0] === 'prepare')).toBe(false)

  const functionCallKey = harness()
  await expect(
    functionCallKey.handler.request(
      {
        method: 'signTransaction',
        params: [
          {
            receiverId: 'contract.testnet',
            actions: [
              {
                type: 'AddKey',
                params: {
                  publicKey: otherKey,
                  accessKey: {
                    permission: { receiverId: 'app.testnet', methodNames: ['ping'] }
                  }
                }
              }
            ]
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: -32602 })
  expect(functionCallKey.calls.some(call => call[0] === 'prepare')).toBe(false)
})

const implicitAccount = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const signingKey = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25'
const summaryBlockHash = '11111111111111111111111111111111'

function preparedNearSummary(actions, receiverId = implicitAccount) {
  return {
    requestId: 1,
    account: {
      accountId: `near:testnet:${implicitAccount}`,
      address: implicitAccount,
      derivationPath: "m/44'/397'/0'",
      publicKey: signingKey,
      curve: 'ed25519',
      addressScheme: 'near',
      derivationScheme: 'slip10'
    },
    transactionHash: summaryBlockHash,
    summary: {
      chainId: 'near:testnet',
      signerId: implicitAccount,
      receiverId,
      signingPublicKey: signingKey,
      signingImplicitAccountId: implicitAccount,
      accountKeyBinding: 'derived_implicit',
      nonce: '1',
      blockHash: summaryBlockHash,
      transactionHash: summaryBlockHash,
      totalDepositYocto: '0',
      actions
    }
  }
}

function nearPreparePayload(source, receiverId = implicitAccount) {
  return {
    kind: 'near-transaction',
    chainId: 'near:testnet',
    accountIndex: 0,
    ...(source === undefined ? {} : { source }),
    transaction: {
      chainId: 'near:testnet',
      accountIndex: 0,
      signerId: implicitAccount,
      receiverId,
      nonce: '1',
      blockHash: summaryBlockHash,
      actions: [{ type: 'transfer', depositYocto: '1' }]
    }
  }
}

function adaptPreparedNearActions(actions, { dapp = true, receiverId = implicitAccount } = {}) {
  return adaptNearPreparedSigning(
    preparedNearSummary(actions, receiverId),
    nearPreparePayload(dapp ? 'dapp' : undefined, receiverId),
    parseSigningCommandId('signing-command:near:policy'),
    Date.now() + 60_000,
    false
  )
}

test('binds prepared NEP-413 engine summary to its request and rejects internal domains', async () => {
  const nonce = Array(32).fill(1)
  const request = {
    chainId,
    accountIndex: 0,
    accountId: address,
    message: 'hello',
    recipient: 'app.testnet',
    nonce,
    callbackUrl: null,
    state: null
  }
  const raw = {
    requestId: 1,
    account: preparedNearSummary([]).account,
    summary: {
      chainId,
      accountId: address,
      publicKey: signingKey,
      signingImplicitAccountId: implicitAccount,
      accountKeyBinding: 'derived_implicit',
      message: request.message,
      recipient: request.recipient,
      nonce: Buffer.from(nonce).toString('base64'),
      callbackUrl: null,
      state: null,
      signingHash: summaryBlockHash,
      requiresFullAccessKey: false
    }
  }
  const adapt = (summary, requested = request) => adaptNearPreparedSigning(
    { ...raw, summary },
    { kind: 'near-nep413-message', chainId, accountIndex: 0, request: requested },
    parseSigningCommandId('signing-command:near:message-policy'),
    Date.now() + 60_000,
    false
  )
  await expect(adapt(raw.summary)).resolves.toMatchObject({
    prepared: { summary: { fields: { recipient: request.recipient } } }
  })
  for (const field of ['message', 'recipient', 'nonce', 'callbackUrl', 'state']) {
    await expect(adapt({ ...raw.summary, [field]: field === 'nonce' ? Buffer.from(Array(32).fill(2)).toString('base64') : 'changed' }))
      .rejects.toThrow('Prepared NEAR message does not match the request')
  }
  await expect(adapt({ ...raw.summary, recipient: 'intents.near' }, { ...request, recipient: 'intents.near' }))
    .rejects.toThrow('Noir Wallet rejected this NEAR Intents signature request.')
})

test('rejects the same NEAR account-takeover actions when a dApp summary reaches signing', async () => {
  const stake = { type: 'stake', stakeYocto: '1', publicKey: signingKey }
  await expect(adaptPreparedNearActions([stake])).rejects.toThrow(
    'NEAR dApp requests cannot stake.'
  )
  await expect(
    adaptPreparedNearActions([
      {
        type: 'addKey',
        publicKey: signingKey,
        nonce: '0',
        permission: { type: 'fullAccess' }
      }
    ])
  ).rejects.toThrow('NEAR dApp requests cannot add a full-access key.')
  await expect(
    adaptPreparedNearActions([{ type: 'deleteKey', publicKey: signingKey }])
  ).rejects.toThrow('NEAR dApp requests cannot delete a full-access or wallet key.')
  await expect(
    adaptPreparedNearActions([{ type: 'deleteAccount', beneficiaryId: 'bob.near' }])
  ).rejects.toThrow('NEAR dApp requests cannot delete this account.')
  await expect(
    adaptPreparedNearActions([
      { type: 'deployContract', codeSha256: 'ab'.repeat(32), codeByteLength: 3 }
    ])
  ).rejects.toThrow('NEAR dApp requests cannot deploy a contract to this account.')

  await expect(
    adaptPreparedNearActions([{ type: 'transfer', depositYocto: '1' }])
  ).resolves.toMatchObject({ prepared: { summary: { schema: 'near.transaction.v1' } } })
  await expect(
    adaptPreparedNearActions(
      [{ type: 'deployContract', codeSha256: 'ab'.repeat(32), codeByteLength: 3 }],
      { receiverId: 'contract.near' }
    )
  ).resolves.toMatchObject({ prepared: { operation: 'transaction' } })
  await expect(
    adaptPreparedNearActions(
      [
        {
          type: 'addKey',
          publicKey: signingKey,
          nonce: '0',
          permission: {
            type: 'functionCall',
            allowanceYocto: null,
            receiverId: 'app.near',
            methodNames: ['ping']
          }
        }
      ]
    )
  ).resolves.toMatchObject({ prepared: { operation: 'transaction' } })
  await expect(adaptPreparedNearActions([stake], { dapp: false })).resolves.toMatchObject({
    prepared: { operation: 'transaction' }
  })
})

const INTENTS_PUBLIC_KEY_REJECTION = 'NEAR dApp requests cannot add an Intents public key.'

function nestJson(value, layers) {
  let nested = JSON.stringify(value)
  for (let layer = 1; layer < layers; layer += 1) nested = JSON.stringify({ note: nested })
  return nested
}

function nearFunctionCall(receiverId, methodName, args) {
  return {
    receiverId,
    actions: [{ methodName, args, gas: '1', deposit: '0' }]
  }
}

function nearFunctionCallSummary(methodName, argsJson) {
  const bytes = Buffer.from(argsJson, 'utf8')
  return {
    type: 'functionCall',
    methodName,
    args: bytes.toString('base64'),
    argsSha256: 'ab'.repeat(32),
    argsByteLength: bytes.length,
    argsUtf8Preview: argsJson,
    argsPreviewTruncated: false,
    gas: '1',
    depositYocto: '0'
  }
}

function adaptPreparedNearMessage(message, callbackUrl = null) {
  const nonce = Array(32).fill(1)
  const request = {
    chainId,
    accountIndex: 0,
    accountId: address,
    message,
    recipient: 'app.testnet',
    nonce,
    callbackUrl,
    state: null
  }
  return adaptNearPreparedSigning(
    {
      requestId: 1,
      account: preparedNearSummary([]).account,
      summary: {
        chainId,
        accountId: address,
        publicKey: signingKey,
        signingImplicitAccountId: implicitAccount,
        accountKeyBinding: 'derived_implicit',
        message,
        recipient: request.recipient,
        nonce: Buffer.from(nonce).toString('base64'),
        callbackUrl,
        state: null,
        signingHash: summaryBlockHash,
        requiresFullAccessKey: false
      }
    },
    { kind: 'near-nep413-message', chainId, accountIndex: 0, request },
    parseSigningCommandId('signing-command:near:intents-key'),
    Date.now() + 60_000,
    false
  )
}

test('hard-blocks Intents add_public_key calls and intent payloads from a dApp', async () => {
  const intent = { intent: 'add_public_key', public_key: 'ed25519:abc' }
  const escaped = '{"intent":"\\u0061dd_public_key","public_key":"ed25519:abc"}'
  await expectBlockedNearAction(
    [nearFunctionCall('intents.near', 'add_public_key', { public_key: 'ed25519:abc' })],
    INTENTS_PUBLIC_KEY_REJECTION
  )
  await expectBlockedNearAction(
    [
      {
        receiverId: 'intents.far',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'add_public_key',
              args: { public_key: 'ed25519:abc' },
              gas: '1',
              deposit: '1'
            }
          }
        ]
      }
    ],
    INTENTS_PUBLIC_KEY_REJECTION
  )
  await expectBlockedNearAction(
    [
      nearFunctionCall('solver.near', 'execute_intents', {
        signed: [{ payload: { message: JSON.stringify({ intents: [intent] }) } }]
      })
    ],
    INTENTS_PUBLIC_KEY_REJECTION
  )
  await expectBlockedNearAction(
    [
      nearFunctionCall('solver.near', 'execute_intents', [
        ...Buffer.from(JSON.stringify({ intents: [intent] }))
      ])
    ],
    INTENTS_PUBLIC_KEY_REJECTION
  )
  await expectBlockedNearAction(
    [
      {
        transactions: [
          nearFunctionCall('contract.testnet', 'ping', {}),
          nearFunctionCall('intents.near', 'add_public_key', { public_key: 'ed25519:abc' })
        ]
      }
    ],
    INTENTS_PUBLIC_KEY_REJECTION,
    { method: 'signAndSendTransactions' }
  )
  await expectBlockedNearAction(
    [
      nearFunctionCall('intents.near', 'execute_intents', {
        note: nestJson({ ok: true }, MAX_NEAR_INTENTS_JSON_DEPTH + 1)
      })
    ],
    INTENTS_PUBLIC_KEY_REJECTION
  )

  const nonce = Array(32).fill(1)
  const messageBase = {
    message: 'hello',
    recipient: 'app.testnet',
    nonce,
    callbackUrl: null,
    state: null
  }
  for (const request of [
    { ...messageBase, message: JSON.stringify(intent) },
    { ...messageBase, message: escaped },
    { ...messageBase, callbackUrl: JSON.stringify(intent) }
  ]) {
    const state = harness()
    await expect(
      state.handler.request(
        { method: 'signMessage', params: [request] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200, message: INTENTS_PUBLIC_KEY_REJECTION })
    expect(state.calls).toEqual([])
  }

  const prepared = harness({
    preparedMessageFields: {
      message: {
        encoding: 'utf8',
        value: JSON.stringify(intent),
        byteLength: Buffer.byteLength(JSON.stringify(intent)),
        sha256: '00'.repeat(32)
      }
    }
  })
  await expect(
    prepared.handler.request(
      { method: 'signMessage', params: [messageBase] },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: 4200, message: INTENTS_PUBLIC_KEY_REJECTION })
  expect(prepared.calls.map(call => call[0])).toEqual(['prepare', 'cancel'])
})

test('does not treat other add_public_key calls or token intents as Intents key registration', async () => {
  await expect(
    harness().handler.request(
      {
        method: 'signTransaction',
        params: [
          nearFunctionCall('contract.testnet', 'add_public_key', { public_key: 'ed25519:abc' })
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toBe('Ag==')
  await expect(
    harness().handler.request(
      {
        method: 'signTransaction',
        params: [
          nearFunctionCall('solver.near', 'execute_intents', {
            signed: [
              {
                payload: {
                  message: JSON.stringify({
                    intents: [{ intent: 'token_diff', diff: { 'nep141:wrap.near': '1' } }]
                  })
                }
              }
            ]
          })
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toBe('Ag==')
  await expect(
    harness().handler.request(
      {
        method: 'signTransaction',
        params: [
          nearFunctionCall('contract.testnet', 'execute_intents', {
            note: nestJson(
              { intent: 'add_public_key', public_key: 'ed25519:abc' },
              MAX_NEAR_INTENTS_JSON_DEPTH + 1
            )
          })
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toBe('Ag==')
  await expect(
    harness().handler.request(
      {
        method: 'signMessage',
        params: [
          {
            message: 'Please review add_public_key before continuing.',
            recipient: 'app.testnet',
            nonce: Array(32).fill(1),
            callbackUrl: null,
            state: JSON.stringify({ intent: 'add_public_key', public_key: 'ed25519:abc' })
          }
        ]
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toMatchObject({ accountId: address, signature: 'AA==' })
})

test('rejects an Intents add_public_key when a dApp summary reaches signing', async () => {
  const nestedIntent = JSON.stringify({
    signed: [
      {
        payload: {
          message: JSON.stringify({
            intents: [{ intent: 'add_public_key', public_key: 'ed25519:abc' }]
          })
        }
      }
    ]
  })
  await expect(
    adaptPreparedNearActions([nearFunctionCallSummary('add_public_key', '{}')], {
      receiverId: 'intents.near'
    })
  ).rejects.toThrow(INTENTS_PUBLIC_KEY_REJECTION)
  await expect(
    adaptPreparedNearActions([nearFunctionCallSummary('execute_intents', nestedIntent)], {
      receiverId: 'solver.near'
    })
  ).rejects.toThrow(INTENTS_PUBLIC_KEY_REJECTION)
  await expect(
    adaptPreparedNearActions([nearFunctionCallSummary('add_public_key', '{}')], {
      dapp: false,
      receiverId: 'intents.near'
    })
  ).resolves.toMatchObject({ prepared: { operation: 'transaction' } })
  await expect(
    adaptPreparedNearActions(
      [
        nearFunctionCallSummary(
          'execute_intents',
          JSON.stringify({ intents: [{ intent: 'token_diff', diff: {} }] })
        )
      ],
      { receiverId: 'solver.near' }
    )
  ).resolves.toMatchObject({ prepared: { operation: 'transaction' } })

  const intentMessage = JSON.stringify({ intent: 'add_public_key', public_key: 'ed25519:abc' })
  await expect(adaptPreparedNearMessage(intentMessage)).rejects.toThrow(INTENTS_PUBLIC_KEY_REJECTION)
  await expect(adaptPreparedNearMessage('hello', intentMessage)).rejects.toThrow(
    INTENTS_PUBLIC_KEY_REJECTION
  )
  await expect(adaptPreparedNearMessage('Please review add_public_key.')).resolves.toMatchObject({
    prepared: { operation: 'message' }
  })
})
