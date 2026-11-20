import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { hashTypedData } from 'viem'
import { evmContractCallReviewIssues } from '../../../src/infrastructure/chains/evm/evm-contract-call-classification.ts'
import { encodePermit2Lockdown } from '../../../src/infrastructure/chains/evm/evm-permit2-allowance.ts'
import {
  requiresUnknownSensitiveConfirmation,
  resolveSensitiveOperationCategory,
  reviewActionPresentation,
  sensitiveOperationCategory,
  UNKNOWN_SENSITIVE_CONFIRMATION
} from '../../../src/core/security/sensitive-operation-policy.ts'

const digest = '00'.repeat(32)
const owner = '0x1111111111111111111111111111111111111111'
const spender = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'
const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const word = value => value.toString(16).padStart(64, '0')
const addressWord = address => address.slice(2).toLowerCase().padStart(64, '0')
const review = { level: 'caution', issues: [{ code: 'unrecognized-call' }] }

function content(value) {
  return {
    encoding: 'hex',
    value,
    byteLength: (value.length - 2) / 2,
    sha256: digest
  }
}

function evmTransaction(calldata, to = token) {
  return {
    schema: 'evm.transaction.v1',
    chainId: 'eip155:1',
    operation: 'transaction',
    review,
    fields: {
      transactionType: 'eip1559',
      from: owner,
      to,
      nonce: '1',
      valueWei: '0',
      gasLimit: '21000',
      maximumFeeWei: '1',
      gasPriceWei: null,
      maxFeePerGasWei: '1',
      maxPriorityFeePerGasWei: '1',
      accessList: [],
      calldata: content(calldata),
      methodSelector: calldata.slice(0, 10)
    }
  }
}

const typedScalar = (solidityType, value) => ({ kind: 'scalar', solidityType, value })
const typedStruct = (typeName, entries) => ({
  kind: 'struct',
  typeName,
  fields: entries.map(([name, value]) => ({ name, value }))
})

function permitSummary() {
  return {
    schema: 'evm.typed-data.v1',
    chainId: 'eip155:1',
    operation: 'message',
    review: { level: 'standard', issues: [] },
    fields: {
      signer: owner,
      primaryType: 'Permit',
      domain: typedStruct('EIP712Domain', [
        ['name', typedScalar('string', 'Token')],
        ['chainId', typedScalar('uint256', '1')],
        ['verifyingContract', typedScalar('address', token)]
      ]),
      message: typedStruct('Permit', [
        ['owner', typedScalar('address', owner)],
        ['spender', typedScalar('address', spender)],
        ['value', typedScalar('uint256', '42')],
        ['nonce', typedScalar('uint256', '1')],
        ['deadline', typedScalar('uint256', '500')]
      ]),
      digestHex: `0x${digest}`
    }
  }
}

function permit2TransferSummary() {
  return {
    schema: 'evm.typed-data.v1',
    chainId: 'eip155:1',
    operation: 'message',
    review: { level: 'standard', issues: [] },
    fields: {
      signer: owner,
      primaryType: 'PermitTransferFrom',
      domain: typedStruct('EIP712Domain', [
        ['name', typedScalar('string', 'Permit2')],
        ['chainId', typedScalar('uint256', '1')],
        ['verifyingContract', typedScalar('address', permit2)]
      ]),
      message: typedStruct('PermitTransferFrom', [
        [
          'permitted',
          typedStruct('TokenPermissions', [
            ['token', typedScalar('address', token)],
            ['amount', typedScalar('uint256', '42')]
          ])
        ],
        ['spender', typedScalar('address', spender)],
        ['nonce', typedScalar('uint256', '1')],
        ['deadline', typedScalar('uint256', '500')]
      ]),
      digestHex: `0x${digest}`
    }
  }
}

function tronTransaction(kind) {
  return {
    schema: 'tron.transaction.v1',
    chainId: 'tron:0x2b6653dc',
    operation: 'transaction',
    review,
    fields: {
      contract: {
        type: 'trigger-smart-contract',
        interpretation: { kind, spender, amountRaw: '1', to: spender }
      }
    }
  }
}

function nearTransaction(actions) {
  return {
    schema: 'near.transaction.v1',
    chainId: 'near:mainnet',
    operation: 'transaction',
    review,
    fields: { actions }
  }
}

test('treats decoded approvals and permits as authorization', () => {
  const approve = `0x095ea7b3${addressWord(spender)}${'f'.repeat(64)}`
  const increase = `0x39509351${addressWord(spender)}${word(1)}`
  const setAll = `0xa22cb465${addressWord(spender)}${word(1)}`
  const permit2Approve = `0x87517c45${addressWord(token)}${addressWord(spender)}${word(1)}${word(1)}`

  const decrease = `0xa457c2d7${addressWord(spender)}${word(1)}`
  assert.equal(sensitiveOperationCategory(evmTransaction(approve)), 'authorization')
  assert.equal(sensitiveOperationCategory(evmTransaction(increase)), 'authorization')
  assert.equal(sensitiveOperationCategory(evmTransaction(decrease)), 'authorization')
  assert.equal(sensitiveOperationCategory(evmTransaction(setAll)), 'authorization')
  assert.equal(sensitiveOperationCategory(evmTransaction(permit2Approve, permit2)), 'authorization')
  const lockdown = encodePermit2Lockdown([{ token, spender }])
  assert.equal(sensitiveOperationCategory(evmTransaction(lockdown, permit2)), 'authorization')
  assert.equal(sensitiveOperationCategory(evmTransaction(lockdown, token)), null)
  assert.equal(sensitiveOperationCategory(permitSummary()), 'authorization')
  assert.equal(sensitiveOperationCategory(permit2TransferSummary()), 'authorization')
  assert.equal(sensitiveOperationCategory(tronTransaction('trc20-approve')), 'authorization')
})

test('treats fixed account-control calls as account control without changing review issues', () => {
  const next = '0x4444444444444444444444444444444444444444'
  const ownership = `0xf2fde38b${addressWord(next)}`
  const renounce = '0x715018a6'
  const upgrade = `0x3659cfe6${addressWord(next)}`
  const admin = `0x8f283970${addressWord(next)}`

  for (const calldata of [ownership, renounce, upgrade, admin]) {
    assert.equal(sensitiveOperationCategory(evmTransaction(calldata)), 'account-control')
    assert.deepEqual(evmContractCallReviewIssues(calldata, token), [{ code: 'unrecognized-call' }])
  }
  assert.equal(sensitiveOperationCategory(evmTransaction(`${ownership}00`)), null)
  assert.equal(sensitiveOperationCategory(evmTransaction(`0xf2fde38b${'ab'.repeat(32)}`)), null)

  for (const kind of [
    'create-account',
    'deploy-contract',
    'stake',
    'add-key',
    'delete-key',
    'delete-account'
  ]) {
    assert.equal(sensitiveOperationCategory(nearTransaction([{ kind }])), 'account-control')
  }
  assert.equal(
    sensitiveOperationCategory(
      nearTransaction([{ kind: 'transfer' }, { kind: 'add-key' }, { kind: 'function-call' }])
    ),
    'account-control'
  )
})

test('leaves ordinary and unrecognized non-control operations unchanged', () => {
  const transfer = `0xa9059cbb${addressWord(spender)}${word(1)}`
  assert.equal(sensitiveOperationCategory(evmTransaction(transfer)), null)
  assert.equal(sensitiveOperationCategory(tronTransaction('trc20-transfer')), null)
  assert.equal(sensitiveOperationCategory(nearTransaction([{ kind: 'transfer' }])), null)
  assert.equal(
    sensitiveOperationCategory({
      schema: 'solana.transaction.v1',
      fields: { instructions: [{ interpretation: { kind: 'unrecognized' } }] }
    }),
    null
  )
  assert.equal(
    sensitiveOperationCategory({
      ...evmTransaction(`0x095ea7b3${addressWord(spender)}${word(1)}`),
      fields: {
        ...evmTransaction(`0x095ea7b3${addressWord(spender)}${word(1)}`).fields,
        calldata: { ...content('0x095ea7b3'), encoding: 'utf8' }
      }
    }),
    null
  )
})

test('requires a second confirmation only for unknown authorization and account control', () => {
  assert.equal(requiresUnknownSensitiveConfirmation('authorization', 'unknown'), true)
  assert.equal(requiresUnknownSensitiveConfirmation('account-control', 'unknown'), true)
  assert.equal(requiresUnknownSensitiveConfirmation('authorization', 'clear'), false)
  assert.equal(requiresUnknownSensitiveConfirmation('authorization', 'warn'), false)
  assert.equal(requiresUnknownSensitiveConfirmation('authorization', 'block'), false)
  assert.equal(requiresUnknownSensitiveConfirmation(null, 'unknown'), false)
  assert.equal(
    resolveSensitiveOperationCategory(['authorization', null, 'account-control']),
    'account-control'
  )
  assert.equal(resolveSensitiveOperationCategory([null, 'authorization']), 'authorization')

  assert.deepEqual(
    reviewActionPresentation({
      blocked: false,
      category: 'authorization',
      judgment: 'unknown'
    }),
    {
      rejectVariant: 'default',
      confirmVariant: 'outline',
      rejectAutoFocus: true,
      confirmRequiresSecondStep: true
    }
  )
  assert.equal(
    reviewActionPresentation({ blocked: false, category: 'authorization', judgment: 'clear' })
      .confirmVariant,
    'default'
  )
  assert.equal(
    reviewActionPresentation({
      blocked: false,
      category: 'account-control',
      judgment: 'warn'
    }).confirmRequiresSecondStep,
    false
  )
  assert.deepEqual(
    reviewActionPresentation({ blocked: true, category: 'authorization', judgment: 'unknown' }),
    {
      rejectVariant: 'outline',
      confirmVariant: 'secondary',
      rejectAutoFocus: false,
      confirmRequiresSecondStep: false
    }
  )
  assert.equal(UNKNOWN_SENSITIVE_CONFIRMATION.confirmText, 'Continue')
  assert.equal(UNKNOWN_SENSITIVE_CONFIRMATION.cancelText, 'Back')

  const source = readFileSync(
    new URL('../../../src/popup/components/signing/SigningSummaryReview.tsx', import.meta.url),
    'utf8'
  )
  assert.match(source, /disabled=\{isBlocked \|\| confirmDisabled\}/)
  assert.match(source, /autoFocus=\{actions\.rejectAutoFocus\}/)
  assert.match(source, /UNKNOWN_SENSITIVE_CONFIRMATION/)
  assert.match(source, /variant: 'danger'/)
})

test('classifies recognized EIP-712 orders, transfers, and Safe transactions', () => {
  const owner = '0x1111111111111111111111111111111111111111'
  const spender = '0x2222222222222222222222222222222222222222'
  const token = '0x3333333333333333333333333333333333333333'
  const seaport = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC'
  const bytes32 = `0x${'11'.repeat(32)}`
  const reviewState = { level: 'standard', issues: [] }
  const scalar = (solidityType, value) => ({ kind: 'scalar', solidityType, value })
  const struct = (typeName, entries) => ({
    kind: 'struct',
    typeName,
    fields: entries.map(([name, value]) => ({ name, value }))
  })
  const typed = (solidityType, value, types) => {
    const array = solidityType.match(/^(.*)\[([0-9]*)\]$/)
    if (array) {
      return {
        kind: 'array',
        itemType: array[1],
        items: value.map(item => typed(array[1], item, types))
      }
    }
    const definition = types[solidityType]
    if (definition) {
      return struct(
        solidityType,
        definition.map(field => [field.name, typed(field.type, value[field.name], types)])
      )
    }
    return scalar(
      solidityType,
      typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'boolean'
          ? String(value)
          : `${value}`
    )
  }
  const domainTypes = domain =>
    ['name', 'version', 'chainId', 'verifyingContract', 'salt']
      .filter(name => Object.hasOwn(domain, name))
      .map(name => ({
        name,
        type: {
          name: 'string',
          version: 'string',
          chainId: 'uint256',
          verifyingContract: 'address',
          salt: 'bytes32'
        }[name]
      }))
  const signed = ({ primaryType, domain, types, message, signer = owner }) => ({
    schema: 'evm.typed-data.v1',
    chainId: 'eip155:1',
    operation: 'message',
    review: reviewState,
    fields: {
      signer,
      primaryType,
      domain: typed('EIP712Domain', domain, { EIP712Domain: domainTypes(domain) }),
      message: typed(primaryType, message, types),
      digestHex: hashTypedData({
        domain,
        types: { EIP712Domain: domainTypes(domain), ...types },
        primaryType,
        message
      })
    }
  })
  const offer = {
    itemType: 2n,
    token,
    identifierOrCriteria: 1n,
    startAmount: 1n,
    endAmount: 1n
  }
  const seaportTypes = {
    OfferItem: [
      { name: 'itemType', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'identifierOrCriteria', type: 'uint256' },
      { name: 'startAmount', type: 'uint256' },
      { name: 'endAmount', type: 'uint256' }
    ],
    ConsiderationItem: [
      { name: 'itemType', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'identifierOrCriteria', type: 'uint256' },
      { name: 'startAmount', type: 'uint256' },
      { name: 'endAmount', type: 'uint256' },
      { name: 'recipient', type: 'address' }
    ],
    OrderComponents: [
      { name: 'offerer', type: 'address' },
      { name: 'zone', type: 'address' },
      { name: 'offer', type: 'OfferItem[]' },
      { name: 'consideration', type: 'ConsiderationItem[]' },
      { name: 'orderType', type: 'uint8' },
      { name: 'startTime', type: 'uint256' },
      { name: 'endTime', type: 'uint256' },
      { name: 'zoneHash', type: 'bytes32' },
      { name: 'salt', type: 'uint256' },
      { name: 'conduitKey', type: 'bytes32' },
      { name: 'counter', type: 'uint256' }
    ]
  }

  assert.equal(
    sensitiveOperationCategory(
      signed({
        primaryType: 'OrderComponents',
        domain: { name: 'Seaport', version: '1.5', chainId: 1, verifyingContract: seaport },
        types: seaportTypes,
        message: {
          offerer: owner,
          zone: spender,
          offer: [offer],
          consideration: [{ ...offer, recipient: owner }],
          orderType: 0n,
          startTime: 1n,
          endTime: 2n,
          zoneHash: bytes32,
          salt: 1n,
          conduitKey: bytes32,
          counter: 0n
        }
      })
    ),
    'authorization'
  )
  assert.equal(
    sensitiveOperationCategory(
      signed({
        primaryType: 'CancelAuthorization',
        domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: token },
        types: {
          CancelAuthorization: [
            { name: 'authorizer', type: 'address' },
            { name: 'nonce', type: 'bytes32' }
          ]
        },
        message: { authorizer: owner, nonce: bytes32 }
      })
    ),
    null
  )
  assert.equal(
    sensitiveOperationCategory(
      signed({
        primaryType: 'SafeTx',
        domain: { chainId: 1, verifyingContract: spender },
        types: {
          SafeTx: [
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
            { name: 'operation', type: 'uint8' },
            { name: 'safeTxGas', type: 'uint256' },
            { name: 'baseGas', type: 'uint256' },
            { name: 'gasPrice', type: 'uint256' },
            { name: 'gasToken', type: 'address' },
            { name: 'refundReceiver', type: 'address' },
            { name: 'nonce', type: 'uint256' }
          ]
        },
        message: {
          to: token,
          value: 1n,
          data: '0x',
          operation: 0n,
          safeTxGas: 0n,
          baseGas: 0n,
          gasPrice: 0n,
          gasToken: owner,
          refundReceiver: owner,
          nonce: 1n
        }
      })
    ),
    'account-control'
  )
})
