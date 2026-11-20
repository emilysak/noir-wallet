import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { hashTypedData } from 'viem'
import {
  PERMIT2_CONTRACT,
  PERMIT2_LOCKDOWN_EFFECT,
  PERMIT2_TOKEN_REVOKE_EFFECT
} from '../../../src/infrastructure/chains/evm/evm-contract-call-classification.ts'
import { encodePermit2Lockdown } from '../../../src/infrastructure/chains/evm/evm-permit2-allowance.ts'

import { SIGNING_SUMMARY_SCHEMAS } from '../../../src/core/keyring/domain/index.ts'
import { sensitiveOperationCategory } from '../../../src/core/security/sensitive-operation-policy.ts'
import { decodeEvmPermitReview } from '../../../src/infrastructure/chains/evm/evm-permit-review.ts'
import { decodeEvmTypedDataRecognition } from '../../../src/infrastructure/chains/evm/evm-typed-data-recognition.ts'
import { buildSigningSummaryReviewModel } from '../../../src/popup/components/signing/signing-summary-review-model.ts'

const digest = '00'.repeat(32)
const content = (encoding = 'utf8', value = 'hello') => ({
  encoding,
  value,
  byteLength: value.length,
  sha256: digest
})
const review = { level: 'standard', issues: [] }

function summary(schema, chainId, operation, fields, summaryReview = review) {
  return { schema, chainId, operation, review: summaryReview, fields }
}

const baseSummaries = [
  summary('zcash.transaction.v1', 'bip122:zcash', 'transaction', {
    kind: 'transfer',
    signer: 'u1sender',
    fundingSource: 'shielded',
    recipients: [{ address: 'u1recipient', amountZats: '9000' }],
    feeZats: '1000',
    transparentInputZats: '0',
    shieldedInputZats: '10000',
    transparentOutputZats: '0',
    shieldedOutputZats: '9000'
  }),
  summary('zcash.message.v1', 'bip122:zcash', 'message', {
    signer: 'u1sender',
    message: content()
  }),
  summary('evm.transaction.v1', 'eip155:1', 'transaction', {
    transactionType: 'eip1559',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    nonce: '1',
    valueWei: '1',
    gasLimit: '21000',
    maximumFeeWei: '2',
    gasPriceWei: null,
    maxFeePerGasWei: '1',
    maxPriorityFeePerGasWei: '1',
    accessList: [],
    calldata: content('hex', '0x'),
    methodSelector: null
  }),
  summary('evm.personal-message.v1', 'eip155:1', 'message', {
    signer: '0x1111111111111111111111111111111111111111',
    message: content()
  }),
  summary('evm.typed-data.v1', 'eip155:1', 'message', {
    signer: '0x1111111111111111111111111111111111111111',
    primaryType: 'Mail',
    domain: { kind: 'struct', typeName: 'Domain', fields: [] },
    message: { kind: 'scalar', solidityType: 'string', value: 'hello' },
    digestHex: `0x${digest}`
  }),
  summary('bitcoin.psbt.v1', 'bip122:bitcoin', 'transaction', {
    psbtVersion: 0,
    signer: 'bc1qsigner',
    inputs: [
      {
        index: 0,
        transactionId: digest,
        outputIndex: 0,
        amountSats: '1000',
        sequence: 0xffffffff,
        scriptType: 'p2wpkh',
        sighashType: 'SIGHASH_ALL',
        ownership: 'signing-account'
      }
    ],
    outputs: [
      {
        index: 0,
        address: 'bc1qrecipient',
        scriptPubKeyHex: '0014',
        amountSats: '900',
        classification: 'recipient'
      }
    ],
    signingInputIndexes: [0],
    totalInputSats: '1000',
    totalOutputSats: '900',
    feeSats: '100'
  }),
  summary('bitcoin.bip322-message.v1', 'bip122:bitcoin', 'message', {
    address: 'bc1qsigner',
    message: content()
  }),
  summary('solana.transaction.v1', 'solana:mainnet', 'transaction', {
    messageVersion: 'legacy',
    feePayer: 'FeePayer111111111111111111111111111111111',
    recentBlockhash: 'Blockhash11111111111111111111111111111111',
    requiredSigners: ['FeePayer111111111111111111111111111111111'],
    staticAccountKeys: [],
    addressTableLookups: [],
    feeLamports: null,
    computeUnitLimit: null,
    computeUnitPriceMicroLamports: null,
    maximumPriorityFeeLamports: null,
    simulationStatus: 'not-run',
    simulationUnitsConsumed: null,
    instructions: [
      {
        index: 0,
        programId: '11111111111111111111111111111111',
        accounts: [],
        data: content('base64', 'AQ=='),
        interpretation: {
          kind: 'system-transfer',
          from: 'FeePayer111111111111111111111111111111111',
          to: 'Recipient11111111111111111111111111111111',
          lamports: '1'
        }
      }
    ]
  }),
  summary('solana.message.v1', 'solana:mainnet', 'message', {
    signer: 'FeePayer111111111111111111111111111111111',
    domain: 'example.com',
    message: content()
  }),
  summary('tron.sign-message-v2.v1', 'tron:0x2b6653dc', 'message', {
    signer: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
    prefix: '\u0019TRON Signed Message:\n',
    message: content(),
    signingHash: digest
  }),
  summary('near.transaction.v1', 'near:mainnet', 'transaction', {
    signerId: 'alice.near',
    publicKey: 'ed25519:public-key',
    nonce: '1',
    receiverId: 'bob.near',
    blockHash: digest,
    actions: [{ kind: 'transfer', depositYocto: '1' }]
  }),
  summary('near.nep413-message.v1', 'near:mainnet', 'message', {
    signerId: 'alice.near',
    publicKey: 'ed25519:public-key',
    message: content(),
    nonceBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    recipient: 'example.com',
    callbackUrl: null
  })
]

const permitOwner = '0x1111111111111111111111111111111111111111'
const permitSpender = '0x2222222222222222222222222222222222222222'
const permitToken = '0x3333333333333333333333333333333333333333'
const permit2Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const typedScalar = (solidityType, value) => ({ kind: 'scalar', solidityType, value })
const typedStruct = (typeName, entries) => ({
  kind: 'struct',
  typeName,
  fields: entries.map(([name, value]) => ({ name, value }))
})
const typedArray = (itemType, items) => ({ kind: 'array', itemType, items })
const permitDetails = () =>
  typedStruct('PermitDetails', [
    ['token', typedScalar('address', permitToken)],
    ['amount', typedScalar('uint160', '42')],
    ['expiration', typedScalar('uint48', '400')],
    ['nonce', typedScalar('uint48', '1')]
  ])
const tokenPermissions = () =>
  typedStruct('TokenPermissions', [
    ['token', typedScalar('address', permitToken)],
    ['amount', typedScalar('uint256', '42')]
  ])
const permitDomain = contract =>
  typedStruct('EIP712Domain', [
    ['name', typedScalar('string', contract === permit2Address ? 'Permit2' : 'Token')],
    ['chainId', typedScalar('uint256', '1')],
    ['verifyingContract', typedScalar('address', contract)]
  ])
const permitSummary = (message, contract = permit2Address, digestHex = `0x${digest}`) =>
  summary('evm.typed-data.v1', 'eip155:1', 'message', {
    signer: permitOwner,
    primaryType: message.typeName,
    domain: permitDomain(contract),
    message,
    digestHex
  })

function permit2BatchDigest(primaryType, arraySuffix = '[]') {
  const transfer = primaryType === 'PermitBatchTransferFrom'
  return hashTypedData({
    domain: { name: 'Permit2', chainId: 1, verifyingContract: permit2Address },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      ...(transfer
        ? {
            TokenPermissions: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' }
            ],
            PermitBatchTransferFrom: [
              { name: 'permitted', type: `TokenPermissions${arraySuffix}` },
              { name: 'spender', type: 'address' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' }
            ]
          }
        : {
            PermitDetails: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint160' },
              { name: 'expiration', type: 'uint48' },
              { name: 'nonce', type: 'uint48' }
            ],
            PermitBatch: [
              { name: 'details', type: `PermitDetails${arraySuffix}` },
              { name: 'spender', type: 'address' },
              { name: 'sigDeadline', type: 'uint256' }
            ]
          })
    },
    primaryType,
    message: transfer
      ? {
          permitted: [1, 2].map(() => ({ token: permitToken, amount: 42n })),
          spender: permitSpender,
          nonce: 1n,
          deadline: 500n
        }
      : {
          details: [1, 2].map(() => ({
            token: permitToken,
            amount: 42n,
            expiration: 400n,
            nonce: 1n
          })),
          spender: permitSpender,
          sigDeadline: 500n
        }
  })
}

test('decodes only canonical EIP-2612 and Permit2 allowance and transfer permissions', () => {
  const permit = permitSummary(
    typedStruct('Permit', [
      ['owner', typedScalar('address', permitOwner)],
      ['spender', typedScalar('address', permitSpender)],
      ['value', typedScalar('uint256', '42')],
      ['nonce', typedScalar('uint256', '1')],
      ['deadline', typedScalar('uint256', '500')]
    ]),
    permitToken
  )
  const single = permitSummary(
    typedStruct('PermitSingle', [
      ['details', permitDetails()],
      ['spender', typedScalar('address', permitSpender)],
      ['sigDeadline', typedScalar('uint256', '500')]
    ])
  )
  const batch = permitSummary(
    typedStruct('PermitBatch', [
      ['details', typedArray('PermitDetails', [permitDetails(), permitDetails()])],
      ['spender', typedScalar('address', permitSpender)],
      ['sigDeadline', typedScalar('uint256', '500')]
    ]),
    permit2Address,
    permit2BatchDigest('PermitBatch')
  )
  const transfer = permitSummary(
    typedStruct('PermitTransferFrom', [
      ['permitted', tokenPermissions()],
      ['spender', typedScalar('address', permitSpender)],
      ['nonce', typedScalar('uint256', '1')],
      ['deadline', typedScalar('uint256', '500')]
    ])
  )
  const batchTransfer = permitSummary(
    typedStruct('PermitBatchTransferFrom', [
      ['permitted', typedArray('TokenPermissions', [tokenPermissions(), tokenPermissions()])],
      ['spender', typedScalar('address', permitSpender)],
      ['nonce', typedScalar('uint256', '1')],
      ['deadline', typedScalar('uint256', '500')]
    ]),
    permit2Address,
    permit2BatchDigest('PermitBatchTransferFrom')
  )

  for (const [input, protocol, kind, amountBits, count] of [
    [permit, 'Permit', 'allowance', 256, 1],
    [single, 'Permit2', 'allowance', 160, 1],
    [batch, 'Permit2', 'allowance', 160, 2],
    [transfer, 'Permit2', 'transfer', 256, 1],
    [batchTransfer, 'Permit2', 'transfer', 256, 2]
  ]) {
    const before = JSON.stringify(input)
    const decoded = decodeEvmPermitReview(input)
    expect(decoded).toMatchObject({
      protocol,
      kind,
      owner: permitOwner,
      spender: permitSpender,
      verifyingContract: input.fields.domain.fields[2].value.value,
      signatureDeadlineRaw: '500'
    })
    expect(decoded.tokens).toHaveLength(count)
    expect(decoded.tokens[0]).toMatchObject({
      contractAddress: permitToken,
      amountRaw: '42',
      amountBits
    })
    expect(JSON.stringify(input)).toBe(before)
  }
})

test('falls back for altered permit authority, domain, or signed schema', () => {
  const base = permitSummary(
    typedStruct('PermitSingle', [
      ['details', permitDetails()],
      ['spender', typedScalar('address', permitSpender)],
      ['sigDeadline', typedScalar('uint256', '500')]
    ])
  )
  const altered = change => {
    const copy = structuredClone(base)
    change(copy)
    return copy
  }
  const cases = [
    altered(input => {
      input.chainId = 'eip155:56'
    }),
    altered(input => {
      input.fields.domain.fields.splice(1, 1)
    }),
    altered(input => {
      input.fields.domain.fields[0].value.value = 'Fake Permit2'
    }),
    altered(input => {
      input.fields.domain.fields[2].value.value = permitToken
    }),
    altered(input => {
      input.fields.message.fields.push({
        name: 'witness',
        value: typedScalar('bytes32', `0x${digest}`)
      })
    }),
    altered(input => {
      input.fields.message.fields[0].value.fields[1].value.value = (1n << 160n).toString()
    }),
    altered(input => {
      input.fields.message.fields[0].value.fields[2].value.solidityType = 'uint256'
    }),
    altered(input => {
      input.fields.message.fields[1].value.value = '0xbroken'
    }),
    altered(input => {
      input.fields.message.fields[2].value.value = '-1'
    }),
    altered(input => {
      input.fields.message.fields.reverse()
    }),
    altered(input => {
      input.fields.primaryType = 'PermitWitnessTransferFrom'
    })
  ]
  for (const input of cases) expect(decodeEvmPermitReview(input)).toBeNull()

  const wrongOwner = permitSummary(
    typedStruct('Permit', [
      ['owner', typedScalar('address', permitSpender)],
      ['spender', typedScalar('address', permitSpender)],
      ['value', typedScalar('uint256', '42')],
      ['nonce', typedScalar('uint256', '1')],
      ['deadline', typedScalar('uint256', '500')]
    ]),
    permitToken
  )
  expect(decodeEvmPermitReview(wrongOwner)).toBeNull()

  const fixedArray = permitSummary(
    typedStruct('PermitBatch', [
      ['details', typedArray('PermitDetails', [permitDetails(), permitDetails()])],
      ['spender', typedScalar('address', permitSpender)],
      ['sigDeadline', typedScalar('uint256', '500')]
    ]),
    permit2Address,
    permit2BatchDigest('PermitBatch', '[2]')
  )
  expect(decodeEvmPermitReview(fixedArray)).toBeNull()
})

test('presents exact signed token permissions with trusted metadata and raw typed data', () => {
  const input = permitSummary(
    typedStruct('PermitSingle', [
      [
        'details',
        typedStruct('PermitDetails', [
          ['token', typedScalar('address', permitToken)],
          ['amount', typedScalar('uint160', '6000000')],
          ['expiration', typedScalar('uint48', '400')],
          ['nonce', typedScalar('uint48', '1')]
        ])
      ],
      ['spender', typedScalar('address', permitSpender)],
      ['sigDeadline', typedScalar('uint256', '500')]
    ])
  )
  const before = JSON.stringify(input)
  const known = buildSigningSummaryReviewModel(input, {
    tokenMetadata: [
      {
        contractAddress: permitToken,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verification: 'trusted'
      }
    ]
  })
  expect(known.title).toBe('Token authorization')
  expect(known.tokenAuthorization).toMatchObject({
    protocol: 'Permit2',
    kind: 'allowance',
    owner: permitOwner,
    spender: permitSpender,
    tokens: [{ contractAddress: permitToken, amount: '6', symbol: 'USDC', unlimited: false }]
  })
  const signedRows = known.sections.find(section => section.title === 'Typed data').rows
  expect(signedRows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Domain.chainId', value: 'uint256 · 1' }),
      expect.objectContaining({
        label: 'Domain.verifyingContract',
        value: `address · ${permit2Address}`
      }),
      expect.objectContaining({ label: 'Message.details.amount', value: 'uint160 · 6000000' }),
      expect.objectContaining({ label: 'Message.details.expiration', value: 'uint48 · 400' }),
      expect.objectContaining({ label: 'Message.details.nonce', value: 'uint48 · 1' }),
      expect.objectContaining({ label: 'Message.spender', value: `address · ${permitSpender}` }),
      expect.objectContaining({ label: 'Message.sigDeadline', value: 'uint256 · 500' }),
      expect.objectContaining({ label: 'Digest', value: `0x${digest}` })
    ])
  )
  const unknown = buildSigningSummaryReviewModel(input)
  expect(unknown.tokenAuthorization.tokens[0]).toMatchObject({
    amount: '6000000',
    symbol: null,
    unlimited: false
  })
  expect(unknown.tokenAuthorization.tokens[0].unlimitedUnit).toBeUndefined()
  const unusableDecimals = buildSigningSummaryReviewModel(input, {
    tokenMetadata: [
      {
        contractAddress: permitToken,
        symbol: 'USDC',
        decimals: 6.5,
        verification: 'trusted'
      }
    ]
  })
  expect(unusableDecimals.tokenAuthorization.tokens[0]).toMatchObject({
    amount: '6000000',
    symbol: null,
    unlimited: false
  })

  const maximumAllowance = structuredClone(input)
  maximumAllowance.fields.message.fields[0].value.fields[1].value.value = (
    (1n << 160n) -
    1n
  ).toString()
  expect(
    buildSigningSummaryReviewModel(maximumAllowance).tokenAuthorization.tokens[0]
  ).toMatchObject({
    amount: 'Unlimited',
    unlimited: true,
    unlimitedUnit: 'uint160'
  })

  const maximumTransfer = permitSummary(
    typedStruct('PermitTransferFrom', [
      [
        'permitted',
        typedStruct('TokenPermissions', [
          ['token', typedScalar('address', permitToken)],
          ['amount', typedScalar('uint256', ((1n << 256n) - 1n).toString())]
        ])
      ],
      ['spender', typedScalar('address', permitSpender)],
      ['nonce', typedScalar('uint256', '1')],
      ['deadline', typedScalar('uint256', '500')]
    ])
  )
  const transferModel = buildSigningSummaryReviewModel(maximumTransfer)
  expect(transferModel.title).toBe('Token transfer authorization')
  expect(transferModel.tokenAuthorization.tokens[0]).toMatchObject({
    amount: ((1n << 256n) - 1n).toString(),
    unlimited: false
  })
  expect(transferModel.tokenAuthorization.tokens[0].unlimitedUnit).toBeUndefined()
  expect(JSON.stringify(input)).toBe(before)
})

test('formats EVM approval amounts and addresses without changing the signing summary', () => {
  const original = baseSummaries.find(item => item.schema === 'evm.transaction.v1')
  const input = {
    ...original,
    fields: { ...original.fields, valueWei: '2000000000000000', maximumFeeWei: '27019822240488' }
  }
  const before = JSON.stringify(input)
  const model = buildSigningSummaryReviewModel(input, {
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    directContract: true
  })
  const rows = model.sections[0].rows
  expect(rows.find(row => row.label === 'From')).toMatchObject({
    value: '0x1111...111111',
    title: input.fields.from
  })
  expect(rows.find(row => row.label === 'Value')).toMatchObject({ value: '0.002 ETH' })
  expect(rows.find(row => row.label === 'Value').title).toBeUndefined()
  expect(rows.find(row => row.label === 'Maximum fee')).toMatchObject({
    value: '0.00002702 ETH',
    amount: { value: '0.000027019822240488', symbol: 'ETH', profile: 'fee' }
  })
  expect(rows.find(row => row.label === 'Maximum fee').title).toBeUndefined()
  expect(rows.find(row => row.label === 'Execution').value).toBe('Public on-chain')
  expect(JSON.stringify(input)).toBe(before)
  const tiny = buildSigningSummaryReviewModel(original, {
    nativeCurrency: { symbol: 'BNB', decimals: 18 }
  })
  expect(tiny.sections[0].rows.find(row => row.label === 'Value')).toMatchObject({
    value: '<0.00000001 BNB',
    amount: { value: '0.000000000000000001', symbol: 'BNB', profile: 'review' }
  })
})

test('shows requested ERC-20 call arguments only for canonical calldata of known tokens', () => {
  const original = baseSummaries.find(item => item.schema === 'evm.transaction.v1')
  const word = value => value.toString(16).padStart(64, '0')
  const addressWord = address => address.slice(2).padStart(64, '0')
  const tokenContract = original.fields.to
  const recipient = '0x3333333333333333333333333333333333333333'
  const sender = '0x4444444444444444444444444444444444444444'
  const options = {
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    tokenMetadata: [
      {
        contractAddress: tokenContract,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verification: 'trusted'
      }
    ]
  }
  const reviewCall = calldata => {
    const input = {
      ...original,
      fields: {
        ...original.fields,
        valueWei: '0',
        calldata: content('hex', calldata),
        methodSelector: calldata.slice(0, 10)
      }
    }
    return buildSigningSummaryReviewModel(input, options)
  }
  const approve = reviewCall(`0x095ea7b3${addressWord(recipient)}${word(1_500_000)}`)
  const requestRows = approve.sections.find(section => section.title === 'Calldata request').rows
  expect(approve.sections[0].rows.find(row => row.label === 'Native value')).toMatchObject({
    value: '0 ETH'
  })
  expect(requestRows.find(row => row.label === 'Requested spender')).toMatchObject({
    title: recipient
  })
  expect(requestRows.find(row => row.label === 'Requested allowance')).toMatchObject({
    value: '1.5 USDC'
  })
  expect(approve.sections.find(section => section.title === 'Contract data').rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Calldata' })])
  )

  const transfer = reviewCall(`0xa9059cbb${addressWord(recipient)}${word(2_000_000)}`)
  expect(transfer.sections.find(section => section.title === 'Calldata request').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Requested recipient', title: recipient }),
      expect.objectContaining({ label: 'Requested amount', value: '2 USDC' })
    ])
  )
  const transferFrom = reviewCall(
    `0x23b872dd${addressWord(sender)}${addressWord(recipient)}${word(3_000_000)}`
  )
  expect(transferFrom.sections.find(section => section.title === 'Calldata request').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Requested sender', title: sender }),
      expect.objectContaining({ label: 'Requested recipient', title: recipient })
    ])
  )

  const unlimited = `0x095ea7b3${addressWord(recipient)}${'f'.repeat(64)}`
  expect(
    reviewCall(unlimited)
      .sections.find(section => section.title === 'Calldata request')
      .rows.find(row => row.label === 'Requested allowance')
  ).toMatchObject({
    value: 'Unlimited',
    title: 'Maximum uint256 (2^256−1)'
  })
  const unknownApprove = buildSigningSummaryReviewModel(
    {
      ...original,
      fields: {
        ...original.fields,
        calldata: content('hex', unlimited),
        methodSelector: unlimited.slice(0, 10)
      }
    },
    { nativeCurrency: options.nativeCurrency }
  )
  expect(unknownApprove.title).toBe('Token authorization')
  expect(unknownApprove.tokenAuthorization?.tokens[0]).toMatchObject({
    unlimited: true,
    unlimitedUnit: 'uint256',
    amount: 'Unlimited'
  })
  expect(
    unknownApprove.sections.find(section => section.title === 'Calldata request')?.rows
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Requested allowance', value: 'Unlimited' })
    ])
  )

  const decrease = reviewCall(`0xa457c2d7${addressWord(recipient)}${word(42)}`)
  expect(decrease.tokenAuthorization).toMatchObject({
    protocol: 'ERC-20',
    kind: 'allowance',
    spender: recipient,
    tokens: [expect.objectContaining({ unlimited: false })]
  })
  expect(decrease.tokenAuthorization.effect).toBeUndefined()
  expect(decrease.sections.find(section => section.title === 'Calldata request').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Requested method', value: 'decreaseAllowance' }),
      expect.objectContaining({ label: 'Allowance decrease' })
    ])
  )
  const permit2Decrease = reviewCall(
    `0xa457c2d7${addressWord(permit2Address.toLowerCase())}${word(42)}`
  )
  expect(permit2Decrease.tokenAuthorization.effect).toBe('revoke-permit2')
  expect(permit2Decrease.description).toContain('Revoking this stops Permit2')

  for (const calldata of [`0x23b872dd${addressWord(sender)}${addressWord(recipient)}${word(42)}`]) {
    const unknownToken = buildSigningSummaryReviewModel(
      {
        ...original,
        fields: {
          ...original.fields,
          calldata: content('hex', calldata),
          methodSelector: calldata.slice(0, 10)
        }
      },
      { nativeCurrency: options.nativeCurrency }
    )
    expect(unknownToken.sections.some(section => section.title === 'Calldata request')).toBe(false)
    expect(unknownToken.sections[0].rows.find(row => row.label === 'Contract')).toMatchObject({
      title: tokenContract
    })
    expect(unknownToken.sections.find(section => section.title === 'Contract data').rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Calldata', value: calldata })])
    )
  }

  const malformed = [
    `0x095ea7b3${addressWord(recipient)}${word(1)}00`,
    `0x095ea7b3${'f'.repeat(24)}${recipient.slice(2)}${word(1)}`,
    `0x095ea7b3${addressWord(recipient)}${word(1).slice(2)}`
  ]
  for (const calldata of malformed) {
    expect(
      reviewCall(calldata).sections.some(section => section.title === 'Calldata request')
    ).toBe(false)
  }
})

const tronOwner = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const tronReceiver = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'

function tronTransaction(contract, summaryReview = review, overrides = {}) {
  return summary(
    'tron.transaction.v1',
    'tron:0x2b6653dc',
    'transaction',
    {
      signer: tronOwner,
      owner: contract.owner,
      ownerMatchesSigner: contract.owner === tronOwner,
      permissionId: 0,
      transactionId: digest,
      rawData: { byteLength: 128, sha256: digest },
      refBlockBytes: 'abcd',
      refBlockNum: '123',
      refBlockHash: '11'.repeat(8),
      expirationMs: '1700000060000',
      timestampMs: '1700000000000',
      feeLimitSun: '100000000',
      memo: content('utf8', ''),
      existingSigners: [],
      contract,
      ...overrides
    },
    summaryReview
  )
}

const tronContracts = [
  { type: 'transfer', owner: tronOwner, to: tronReceiver, amountSun: '1' },
  {
    type: 'transfer-asset',
    owner: tronOwner,
    to: tronReceiver,
    assetName: content('utf8', '1002000'),
    amountRaw: '2'
  },
  {
    type: 'vote-witness',
    owner: tronOwner,
    votes: [{ voteAddress: tronReceiver, voteCount: '3' }]
  },
  {
    type: 'trigger-smart-contract',
    owner: tronOwner,
    contractAddress: tronReceiver,
    callValueSun: '0',
    callTokenValue: '0',
    tokenId: '0',
    calldata: content('hex', '0xa9059cbb'),
    methodSelector: '0xa9059cbb',
    interpretation: { kind: 'trc20-transfer', to: tronReceiver, amountRaw: '4' }
  },
  { type: 'freeze-balance-v2', owner: tronOwner, resource: 'energy', amountSun: '5' },
  { type: 'unfreeze-balance-v2', owner: tronOwner, resource: 'bandwidth', amountSun: '6' },
  { type: 'withdraw-expire-unfreeze', owner: tronOwner },
  {
    type: 'delegate-resource',
    owner: tronOwner,
    receiver: tronReceiver,
    resource: 'energy',
    amountSun: '7',
    locked: true,
    lockPeriod: '28800'
  },
  {
    type: 'undelegate-resource',
    owner: tronOwner,
    receiver: tronReceiver,
    resource: 'bandwidth',
    amountSun: '8'
  },
  { type: 'cancel-all-unfreeze-v2', owner: tronOwner }
]

test.describe('Signing summary review model', () => {
  test('renders every frozen schema with explicit request and chain rows after the action details', () => {
    const summaries = [
      baseSummaries[0],
      ...baseSummaries.slice(1, 9),
      tronTransaction(tronContracts[0]),
      ...baseSummaries.slice(9)
    ]
    expect(summaries.map(item => item.schema).sort()).toEqual([...SIGNING_SUMMARY_SCHEMAS].sort())

    for (const item of summaries) {
      const model = buildSigningSummaryReviewModel(item)
      expect(model.title.length).toBeGreaterThan(0)
      expect(model.operation).toBe(item.operation)
      expect(model.sections.at(-1)?.rows).toEqual([
        { label: 'Schema', value: item.schema, code: true, breakAll: true },
        { label: 'Chain ID', value: item.chainId, code: true, breakAll: true }
      ])
    }
  })

  test('renders all ten supported TRON contracts without a generic fallback', () => {
    expect(
      tronContracts.map(contract => buildSigningSummaryReviewModel(tronTransaction(contract)).title)
    ).toEqual([
      'Send TRX',
      'Send TRC-10 token',
      'Vote for witnesses',
      'Send TRC-20 token',
      'Freeze TRX',
      'Unfreeze TRX',
      'Withdraw unfrozen TRX',
      'Delegate resources',
      'Undelegate resources',
      'Cancel all unfreezes'
    ])
  })

  test('does not claim a reviewable EVM calldata request is blocked', () => {
    const evmCall = structuredClone(baseSummaries[2])
    evmCall.review = { level: 'caution', issues: [{ code: 'unrecognized-call' }] }
    evmCall.fields.calldata = content('hex', '0x12345678')
    evmCall.fields.methodSelector = '0x12345678'

    const model = buildSigningSummaryReviewModel(evmCall)
    expect(model.level).toBe('caution')
    expect(model.issues[0].description).toContain('Verify the destination and full calldata')
    expect(model.issues[0].description).not.toContain('will not sign')
  })

  test('shows EVM per-gas fees in GWEI without losing fractional precision', () => {
    const evm = structuredClone(baseSummaries[2])
    evm.fields.gasPriceWei = '1500000000'
    evm.fields.maxFeePerGasWei = '2123456789'
    evm.fields.maxPriorityFeePerGasWei = '250000000'

    const rows = buildSigningSummaryReviewModel(evm).sections.flatMap(section => section.rows)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Gas price', value: '1.5 GWEI' }),
        expect.objectContaining({ label: 'Max fee per gas', value: '2.123456789 GWEI' }),
        expect.objectContaining({ label: 'Priority fee per gas', value: '0.25 GWEI' })
      ])
    )
  })

  test('shows Solana total fee, compute unit price, and maximum priority fee', () => {
    const solana = structuredClone(baseSummaries[7])
    solana.fields.feeLamports = '5050'
    solana.fields.computeUnitLimit = '200000'
    solana.fields.computeUnitPriceMicroLamports = '250'
    solana.fields.maximumPriorityFeeLamports = '50'
    solana.fields.simulationStatus = 'succeeded'
    solana.fields.simulationUnitsConsumed = '12345'
    solana.fields.instructions = [
      {
        index: 0,
        programId: 'ComputeBudget111111111111111111111111111111',
        accounts: [],
        data: content('base64', 'AsANAwA='),
        interpretation: { kind: 'compute-unit-limit', units: '200000' }
      },
      {
        index: 1,
        programId: 'ComputeBudget111111111111111111111111111111',
        accounts: [],
        data: content('base64', 'A/oAAAAAAAAA'),
        interpretation: { kind: 'compute-unit-price', microLamports: '250' }
      }
    ]
    const rows = buildSigningSummaryReviewModel(solana).sections.flatMap(section => section.rows)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'RPC total fee', value: '5050 lamports' }),
        expect.objectContaining({ label: 'CU price', value: '250 micro-lamports/CU' }),
        expect.objectContaining({ label: 'Max priority fee', value: '50 lamports' }),
        expect.objectContaining({ label: 'Simulated units', value: '12345' })
      ])
    )
  })

  test('makes approval, permission, multisign, and unknown calldata risks visible', () => {
    const maxAllowance =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const approvalContract = {
      ...tronContracts[3],
      methodSelector: '0x095ea7b3',
      interpretation: { kind: 'trc20-approve', spender: tronReceiver, amountRaw: maxAllowance }
    }
    const caution = buildSigningSummaryReviewModel(
      tronTransaction(
        { ...approvalContract, owner: tronReceiver },
        {
          level: 'caution',
          issues: [
            { code: 'active-permission' },
            { code: 'owner-signer-mismatch' },
            { code: 'multisign' },
            { code: 'token-approval' },
            { code: 'unlimited-token-approval' }
          ]
        },
        { permissionId: 2, existingSigners: [tronReceiver] }
      )
    )
    expect(caution.level).toBe('caution')
    expect(caution.issues.map(issue => issue.title)).toEqual([
      'Unlimited token approval',
      'Token spending approval',
      'Owner and signer differ',
      'TRON active permission',
      'Partially signed transaction'
    ])
    expect(caution.issues[0].description).toContain('2^256−1')
    expect(caution.issues[0].description).toContain('2^160−1')

    const blocked = buildSigningSummaryReviewModel(
      tronTransaction(
        { ...tronContracts[3], interpretation: { kind: 'unrecognized' } },
        { level: 'blocked', issues: [{ code: 'unrecognized-call' }] }
      )
    )
    expect(blocked.title).toBe('Unknown smart contract call')
    expect(blocked.level).toBe('blocked')
    expect(blocked.issues[0].description).toContain('will not sign')
  })

  test('presents typed-data fields without exposing the internal tagged-value envelope', () => {
    const model = buildSigningSummaryReviewModel(
      summary('evm.typed-data.v1', 'eip155:1', 'message', {
        signer: '0x1111111111111111111111111111111111111111',
        primaryType: 'Message',
        domain: {
          kind: 'struct',
          typeName: 'EIP712Domain',
          fields: [
            {
              name: 'name',
              value: { kind: 'scalar', solidityType: 'string', value: 'Noir Wallet' }
            }
          ]
        },
        message: {
          kind: 'struct',
          typeName: 'Message',
          fields: [
            {
              name: 'contents',
              value: { kind: 'scalar', solidityType: 'string', value: 'Ownership proof' }
            }
          ]
        },
        digestHex: `0x${digest}`
      })
    )

    const typedData = model.sections.find(section => section.title === 'Typed data')
    expect(typedData?.rows).toContainEqual({
      label: 'Domain.name',
      value: 'Self-reported · Noir Wallet',
      code: true
    })
    expect(typedData?.rows).toContainEqual({
      label: 'Message.contents',
      value: 'string · Ownership proof',
      code: true
    })
    expect(JSON.stringify(typedData)).not.toContain('"kind":"scalar"')
  })

  test('shows bidirectional controls in messages and typed-data strings without changing the signed payload', () => {
    const hidden = 'Send 1 ZEC\u202E to attacker'
    const personal = summary('evm.personal-message.v1', 'eip155:1', 'message', {
      signer: '0x1111111111111111111111111111111111111111',
      message: content('utf8', hidden)
    })
    const personalModel = buildSigningSummaryReviewModel(personal)
    const contentRow = personalModel.sections
      .flatMap(section => section.rows)
      .find(row => row.label === 'Content')
    expect(contentRow).toMatchObject({
      value: 'Send 1 ZEC[U+202E] to attacker',
      hiddenCharacters: true
    })
    expect(personal.fields.message.value).toBe(hidden)
    expect(personal.fields.message.sha256).toBe(digest)

    const typed = summary('evm.typed-data.v1', 'eip155:1', 'message', {
      signer: '0x1111111111111111111111111111111111111111',
      primaryType: 'Message',
      domain: { kind: 'struct', typeName: 'EIP712Domain', fields: [] },
      message: { kind: 'scalar', solidityType: 'string', value: hidden },
      digestHex: `0x${digest}`
    })
    const typedModel = buildSigningSummaryReviewModel(typed)
    const messageRow = typedModel.sections
      .flatMap(section => section.rows)
      .find(row => row.label === 'Message')
    expect(messageRow).toMatchObject({
      value: 'string · Send 1 ZEC[U+202E] to attacker',
      hiddenCharacters: true
    })
    expect(typed.fields.message.value).toBe(hidden)
    expect(typed.fields.digestHex).toBe(`0x${digest}`)
  })

  test('keeps the renderer independent from runtime, Worker, store, and WASM inputs', () => {
    const source = [
      'signing-summary-review-model.ts',
      'signing-summary-review-model-other.ts',
      'signing-summary-review-model-tron.ts',
      'signing-summary-review-model-types.ts',
      'SigningSummaryReview.tsx'
    ]
      .map(file =>
        readFileSync(
          new URL(`../../../src/popup/components/signing/${file}`, import.meta.url),
          'utf8'
        )
      )
      .join('\n')

    expect(source).not.toMatch(/\bany\b|chrome\.|postMessage|WORKER_RPC|wasm-pkg/i)
    expect(source).not.toMatch(/@\/store|zcash-wallet-runtime/)
    expect(source).toMatch(/disabled=\{isBlocked \|\| confirmDisabled\}/)
  })

  test('withholds success for simulation and verification on a dApp RPC', () => {
    const original = baseSummaries.find(item => item.schema === 'evm.transaction.v1')
    const recipient = '0x3333333333333333333333333333333333333333'
    const word = value => value.toString(16).padStart(64, '0')
    const calldata = `0x095ea7b3${recipient.slice(2).padStart(64, '0')}${word(1)}`
    const input = {
      ...original,
      fields: {
        ...original.fields,
        valueWei: '0',
        calldata: content('hex', calldata),
        methodSelector: calldata.slice(0, 10)
      }
    }
    const model = buildSigningSummaryReviewModel(input, { rpcOrigin: 'dapp' })
    expect(model.title).toBe('Token authorization')
    expect(model.sections.find(section => section.title === 'Network node').rows).toEqual([
      { label: 'RPC', value: 'Added by dApp' },
      { label: 'Simulation', value: 'UNKNOWN' },
      { label: 'Balance check', value: 'UNKNOWN' },
      { label: 'Authorization check', value: 'UNKNOWN' },
      { label: 'Node', value: 'Unverified node' }
    ])
    expect(JSON.stringify(model)).not.toMatch(/Success/)
    const builtin = buildSigningSummaryReviewModel(input, { rpcOrigin: 'builtin' })
    expect(builtin.sections.some(section => section.title === 'Network node')).toBe(false)
    expect(JSON.stringify(builtin)).not.toMatch(/Success/)
  })

  test('does not confirm an ERC-721 revocation on a non-builtin RPC', () => {
    const original = baseSummaries.find(item => item.schema === 'evm.transaction.v1')
    const operator = '0x3333333333333333333333333333333333333333'
    const word = value => value.toString(16).padStart(64, '0')
    const calldata = approved => `0xa22cb465${operator.slice(2).padStart(64, '0')}${word(approved)}`
    const input = approved => ({
      ...original,
      fields: {
        ...original.fields,
        valueWei: '0',
        calldata: content('hex', calldata(approved)),
        methodSelector: '0xa22cb465'
      }
    })
    const amountFor = origin =>
      buildSigningSummaryReviewModel(input(0), { rpcOrigin: origin }).tokenAuthorization.tokens[0]
        .amount

    expect(amountFor('dapp')).toBe('UNKNOWN')
    expect(amountFor('user')).toBe('UNKNOWN')
    expect(amountFor('builtin')).toBe('Revoked')
    expect(buildSigningSummaryReviewModel(input(0)).tokenAuthorization.tokens[0].amount).toBe(
      'Revoked'
    )
    expect(
      buildSigningSummaryReviewModel(input(1), { rpcOrigin: 'dapp' }).tokenAuthorization.tokens[0]
        .amount
    ).toBe('All token IDs')
    expect(JSON.stringify(input(0))).not.toMatch(/Revoked|UNKNOWN/)
  })
})

const zeroAddress = '0x0000000000000000000000000000000000000000'
const bytes32Value = `0x${'11'.repeat(32)}`
const seaport15 = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC'
const blurExchange = '0x000000000000Ad05Ccc4F10045630fb830B95127'
const inchRouter = '0x111111125421cA6dc452d289314280a0f8842A65'
const cowSettlement = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'

function domainFields(domain) {
  const order = ['name', 'version', 'chainId', 'verifyingContract', 'salt']
  const solidity = {
    name: 'string',
    version: 'string',
    chainId: 'uint256',
    verifyingContract: 'address',
    salt: 'bytes32'
  }
  return order
    .filter(name => Object.hasOwn(domain, name))
    .map(name => ({ name, type: solidity[name] }))
}

function encodeTypedValue(solidityType, value, types) {
  const array = solidityType.match(/^(.*)\[([0-9]*)\]$/)
  if (array) {
    return {
      kind: 'array',
      itemType: array[1],
      items: value.map(item => encodeTypedValue(array[1], item, types))
    }
  }
  const struct = types[solidityType]
  if (struct) {
    return {
      kind: 'struct',
      typeName: solidityType,
      fields: struct.map(field => ({
        name: field.name,
        value: encodeTypedValue(field.type, value[field.name], types)
      }))
    }
  }
  return {
    kind: 'scalar',
    solidityType,
    value:
      typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'boolean'
          ? value
            ? 'true'
            : 'false'
          : `${value}`
  }
}

function recognizedSummary({
  primaryType,
  domain,
  types,
  message,
  signer = permitOwner,
  chainId = 'eip155:1',
  digestTypes = types
}) {
  const digestHex = hashTypedData({
    domain,
    types: { EIP712Domain: domainFields(domain), ...digestTypes },
    primaryType,
    message
  })
  return summary('evm.typed-data.v1', chainId, 'message', {
    signer,
    primaryType,
    domain: encodeTypedValue('EIP712Domain', domain, { EIP712Domain: domainFields(domain) }),
    message: encodeTypedValue(primaryType, message, types),
    digestHex
  })
}

const permit2Domain = { name: 'Permit2', chainId: 1, verifyingContract: permit2Address }
const daiTypes = {
  Permit: [
    { name: 'holder', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'allowed', type: 'bool' }
  ]
}
const tokenPermissionFields = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' }
]
const exampleTrade = [
  { name: 'receiver', type: 'address' },
  { name: 'minimum', type: 'uint256' }
]
const witnessFields = witnessType => [
  { name: 'permitted', type: witnessType },
  { name: 'spender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'witness', type: 'ExampleTrade' }
]
const transferAuthorization = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' }
]
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
const blurTypes = {
  Fee: [
    { name: 'rate', type: 'uint16' },
    { name: 'recipient', type: 'address' }
  ],
  Order: [
    { name: 'trader', type: 'address' },
    { name: 'side', type: 'uint8' },
    { name: 'matchingPolicy', type: 'address' },
    { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'paymentToken', type: 'address' },
    { name: 'price', type: 'uint256' },
    { name: 'listingTime', type: 'uint256' },
    { name: 'expirationTime', type: 'uint256' },
    { name: 'fees', type: 'Fee[]' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraParams', type: 'bytes' },
    { name: 'nonce', type: 'uint256' }
  ]
}
const inchTypes = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'makerAsset', type: 'address' },
    { name: 'takerAsset', type: 'address' },
    { name: 'makingAmount', type: 'uint256' },
    { name: 'takingAmount', type: 'uint256' },
    { name: 'makerTraits', type: 'uint256' }
  ]
}
const cowTypes = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'bytes32' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'bytes32' },
    { name: 'buyTokenBalance', type: 'bytes32' }
  ]
}
const safeTypes = {
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
}
const seaportDomain = {
  name: 'Seaport',
  version: '1.5',
  chainId: 1,
  verifyingContract: seaport15
}
const seaportMessage = {
  offerer: permitOwner,
  zone: permitSpender,
  offer: [
    {
      itemType: 2n,
      token: permitToken,
      identifierOrCriteria: 7n,
      startAmount: 1n,
      endAmount: 1n
    }
  ],
  consideration: [
    {
      itemType: 0n,
      token: zeroAddress,
      identifierOrCriteria: 0n,
      startAmount: 9n,
      endAmount: 9n,
      recipient: permitSpender
    }
  ],
  orderType: 0n,
  startTime: 500n,
  endTime: 900n,
  zoneHash: bytes32Value,
  salt: 1n,
  conduitKey: bytes32Value,
  counter: 0n
}
const blurMessage = {
  trader: permitOwner,
  side: 1n,
  matchingPolicy: permitSpender,
  collection: permitToken,
  tokenId: 4n,
  amount: 1n,
  paymentToken: zeroAddress,
  price: 10n,
  listingTime: 500n,
  expirationTime: 0n,
  fees: [{ rate: 250n, recipient: permitSpender }],
  salt: 1n,
  extraParams: '0x01',
  nonce: 2n
}
const safeMessage = {
  to: permitToken,
  value: 5n,
  data: '0x1234',
  operation: 1n,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: zeroAddress,
  refundReceiver: zeroAddress,
  nonce: 3n
}

function daiPermit(allowed = true, expiry = 0n, holder = permitOwner) {
  return recognizedSummary({
    primaryType: 'Permit',
    domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: permitToken },
    types: daiTypes,
    signer: holder,
    message: { holder, spender: permitSpender, nonce: 1n, expiry, allowed }
  })
}

function witnessTransfer(batch = false) {
  const primaryType = batch ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom'
  const permitted = { token: permitToken, amount: 42n }
  return recognizedSummary({
    primaryType,
    domain: permit2Domain,
    types: {
      TokenPermissions: tokenPermissionFields,
      ExampleTrade: exampleTrade,
      [primaryType]: witnessFields(batch ? 'TokenPermissions[]' : 'TokenPermissions')
    },
    message: {
      permitted: batch ? [permitted, permitted] : permitted,
      spender: permitSpender,
      nonce: 1n,
      deadline: 500n,
      witness: { receiver: permitSpender, minimum: 7n }
    }
  })
}

function eip3009(primaryType = 'TransferWithAuthorization', from = permitOwner) {
  const cancel = primaryType === 'CancelAuthorization'
  return recognizedSummary({
    primaryType,
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: permitToken },
    types: cancel
      ? {
          CancelAuthorization: [
            { name: 'authorizer', type: 'address' },
            { name: 'nonce', type: 'bytes32' }
          ]
        }
      : { [primaryType]: transferAuthorization },
    signer: from,
    message: cancel
      ? { authorizer: from, nonce: bytes32Value }
      : {
          from,
          to: permitSpender,
          value: 42n,
          validAfter: 0n,
          validBefore: 500n,
          nonce: bytes32Value
        }
  })
}

function blurOrder(trader = permitOwner) {
  return recognizedSummary({
    primaryType: 'Order',
    domain: { name: 'Blur Exchange', version: '1.0', chainId: 1, verifyingContract: blurExchange },
    types: blurTypes,
    signer: trader,
    message: { ...blurMessage, trader }
  })
}

function inchOrder(receiver = zeroAddress, maker = permitOwner) {
  return recognizedSummary({
    primaryType: 'Order',
    domain: {
      name: '1inch Aggregation Router',
      version: '6',
      chainId: 1,
      verifyingContract: inchRouter
    },
    types: inchTypes,
    signer: maker,
    message: {
      salt: 1n,
      maker,
      receiver,
      makerAsset: permitToken,
      takerAsset: permitSpender,
      makingAmount: 5n,
      takingAmount: 6n,
      makerTraits: 0n
    }
  })
}

function cowOrder(receiver = zeroAddress) {
  return recognizedSummary({
    primaryType: 'Order',
    domain: {
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: 1,
      verifyingContract: cowSettlement
    },
    types: cowTypes,
    message: {
      sellToken: permitToken,
      buyToken: permitSpender,
      receiver,
      sellAmount: 5n,
      buyAmount: 6n,
      validTo: 1_700_000_000n,
      appData: bytes32Value,
      feeAmount: 0n,
      kind: bytes32Value,
      partiallyFillable: false,
      sellTokenBalance: bytes32Value,
      buyTokenBalance: bytes32Value
    }
  })
}

function safeTransaction(operation = 1n) {
  return recognizedSummary({
    primaryType: 'SafeTx',
    domain: { chainId: 1, verifyingContract: permitSpender },
    types: safeTypes,
    message: { ...safeMessage, operation }
  })
}

function recognizedRows(model) {
  return model.sections.find(section => section.title === 'Recognized signature').rows
}

test('recognizes DAI permit, EIP-3009, and Permit2 witness transfers', () => {
  const dai = daiPermit()
  expect(decodeEvmPermitReview(dai)).toMatchObject({
    protocol: 'Permit',
    kind: 'allowance',
    deadlineUnbounded: true,
    spender: permitSpender
  })
  expect(decodeEvmPermitReview(dai).tokens[0].amountRaw).toBe(((1n << 256n) - 1n).toString())
  const daiModel = buildSigningSummaryReviewModel(dai)
  expect(daiModel.title).toBe('Token authorization')
  expect(daiModel.tokenAuthorization.signatureDeadline).toBe('No expiry')
  expect(daiModel.tokenAuthorization.tokens[0]).toMatchObject({
    unlimited: true,
    unlimitedUnit: 'uint256',
    amount: 'Unlimited'
  })
  expect(sensitiveOperationCategory(dai)).toBe('authorization')

  const revoked = daiPermit(false, 500n)
  expect(decodeEvmPermitReview(revoked).tokens[0].amountRaw).toBe('0')
  expect(decodeEvmPermitReview(revoked).deadlineUnbounded).toBeUndefined()

  const witness = witnessTransfer()
  expect(decodeEvmPermitReview(witness)).toMatchObject({
    protocol: 'Permit2',
    kind: 'transfer',
    witnessReceivers: [permitSpender]
  })
  expect(decodeEvmPermitReview(witnessTransfer(true)).tokens).toHaveLength(2)
  expect(sensitiveOperationCategory(witness)).toBe('authorization')
  const bytes32Witness = recognizedSummary({
    primaryType: 'PermitWitnessTransferFrom',
    domain: permit2Domain,
    types: {
      TokenPermissions: tokenPermissionFields,
      PermitWitnessTransferFrom: witnessFields('TokenPermissions').map(field =>
        field.name === 'witness' ? { name: 'witness', type: 'bytes32' } : field
      )
    },
    message: {
      permitted: { token: permitToken, amount: 42n },
      spender: permitSpender,
      nonce: 1n,
      deadline: 500n,
      witness: bytes32Value
    }
  })
  expect(decodeEvmPermitReview(bytes32Witness).witnessReceivers).toBeUndefined()

  const transferModel = buildSigningSummaryReviewModel(eip3009(), {
    tokenMetadata: [
      {
        contractAddress: permitToken,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verification: 'trusted'
      }
    ]
  })
  expect(transferModel.tokenAuthorization).toMatchObject({
    protocol: 'EIP-3009',
    kind: 'transfer',
    recipient: permitSpender,
    validAfter: 'Immediately',
    submission: 'Relayers can submit',
    tokens: [{ symbol: 'USDC', amount: '0.000042' }]
  })
  expect(sensitiveOperationCategory(eip3009())).toBe('authorization')
  expect(transferModel.tokenAuthorization.tokens[0].selfReportedName).toBeUndefined()
  const matchingDomainName = transferModel.sections
    .find(section => section.title === 'Typed data')
    ?.rows.find(row => row.label === 'Domain.name')
  expect(matchingDomainName).toMatchObject({ value: 'string · USD Coin', code: true })

  const reportedPermit = permitSummary(
    typedStruct('Permit', [
      ['owner', typedScalar('address', permitOwner)],
      ['spender', typedScalar('address', permitSpender)],
      ['value', typedScalar('uint256', '42')],
      ['nonce', typedScalar('uint256', '1')],
      ['deadline', typedScalar('uint256', '500')]
    ]),
    permitToken
  )
  const reportedModel = buildSigningSummaryReviewModel(reportedPermit)
  expect(reportedModel.tokenAuthorization.tokens[0]).toMatchObject({
    contractAddress: permitToken,
    symbol: null,
    selfReportedName: 'Token',
    amount: '42'
  })
  expect(
    reportedModel.sections
      .find(section => section.title === 'Typed data')
      ?.rows.find(row => row.label === 'Domain.name')
  ).toMatchObject({
    value: `Self-reported · Token\n${permitToken}`,
    code: true,
    breakAll: true
  })

  const spoofed = recognizedSummary({
    primaryType: 'TransferWithAuthorization',
    domain: { name: 'Tether USD', version: '2', chainId: 1, verifyingContract: permitToken },
    types: { TransferWithAuthorization: transferAuthorization },
    message: {
      from: permitOwner,
      to: permitSpender,
      value: 42n,
      validAfter: 0n,
      validBefore: 500n,
      nonce: bytes32Value
    }
  })
  const spoofedModel = buildSigningSummaryReviewModel(spoofed, {
    tokenMetadata: [
      {
        contractAddress: permitToken,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        verification: 'trusted'
      }
    ]
  })
  expect(spoofedModel.tokenAuthorization.tokens[0]).toMatchObject({
    symbol: 'USDC',
    amount: '0.000042',
    selfReportedName: 'Tether USD'
  })
  expect(
    spoofedModel.sections
      .find(section => section.title === 'Typed data')
      ?.rows.find(row => row.label === 'Domain.name')?.value
  ).toBe(`Self-reported · Tether USD\n${permitToken}`)

  const permit2Model = buildSigningSummaryReviewModel(
    permitSummary(
      typedStruct('PermitSingle', [
        ['details', permitDetails()],
        ['spender', typedScalar('address', permitSpender)],
        ['sigDeadline', typedScalar('uint256', '500')]
      ])
    ),
    {
      tokenMetadata: [
        {
          contractAddress: permitToken,
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
          verification: 'trusted'
        }
      ]
    }
  )
  expect(permit2Model.tokenAuthorization.tokens[0]).toMatchObject({
    symbol: 'USDC',
    amount: '0.000042'
  })
  expect(permit2Model.tokenAuthorization.tokens[0].selfReportedName).toBeUndefined()
  expect(
    buildSigningSummaryReviewModel(eip3009('ReceiveWithAuthorization')).tokenAuthorization
      .submission
  ).toBe('Only the recipient can submit')
  const cancelModel = buildSigningSummaryReviewModel(eip3009('CancelAuthorization'))
  expect(cancelModel.title).toBe('Cancel token authorization')
  expect(cancelModel.tokenAuthorization).toBeUndefined()
  expect(sensitiveOperationCategory(eip3009('CancelAuthorization'))).toBe(null)
  expect(recognizedRows(cancelModel)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Authorizer', value: permitOwner }),
      expect.objectContaining({ label: 'Nonce', value: bytes32Value })
    ])
  )
})

test('recognizes Seaport, Blur, receiver orders, and Safe transactions', () => {
  const seaport = recognizedSummary({
    primaryType: 'OrderComponents',
    domain: seaportDomain,
    types: seaportTypes,
    message: seaportMessage
  })
  const seaportModel = buildSigningSummaryReviewModel(seaport)
  expect(seaportModel.title).toBe('Seaport order')
  expect(seaportModel.description).toBe('This signature creates a Seaport order.')
  expect(sensitiveOperationCategory(seaport)).toBe('authorization')
  expect(recognizedRows(seaportModel)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Offerer', value: permitOwner }),
      expect.objectContaining({ label: 'Offer 1', value: 'ERC-721' }),
      expect.objectContaining({
        label: 'Consideration 1 recipient',
        value: permitSpender,
        tone: 'warning'
      })
    ])
  )
  expect(seaportModel.sections.find(section => section.title === 'Typed data').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Primary type', value: 'OrderComponents' })
    ])
  )

  const blurModel = buildSigningSummaryReviewModel(blurOrder())
  expect(blurModel.title).toBe('Blur order')
  expect(sensitiveOperationCategory(blurOrder())).toBe('authorization')
  expect(recognizedRows(blurModel)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Side', value: 'Sell' }),
      expect.objectContaining({ label: 'Expiration', value: 'Oracle cancellation' }),
      expect.objectContaining({ label: 'Fee 1', value: '250 bps' }),
      expect.objectContaining({ label: 'Fee 1 recipient', value: permitSpender })
    ])
  )

  const defaultReceiver = buildSigningSummaryReviewModel(inchOrder())
  expect(defaultReceiver.title).toBe('1inch order')
  expect(sensitiveOperationCategory(inchOrder())).toBe('authorization')
  expect(recognizedRows(defaultReceiver)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Receiver', value: `Maker · ${permitOwner}` })
    ])
  )
  expect(recognizedRows(buildSigningSummaryReviewModel(inchOrder(permitSpender)))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Receiver', value: permitSpender, tone: 'warning' })
    ])
  )
  const cowModel = buildSigningSummaryReviewModel(cowOrder(permitSpender))
  expect(cowModel.title).toBe('CoW order')
  expect(sensitiveOperationCategory(cowOrder())).toBe('authorization')
  expect(recognizedRows(cowModel)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Receiver', value: permitSpender, tone: 'warning' }),
      expect.objectContaining({ label: 'Sell token', value: permitToken })
    ])
  )

  const safeModel = buildSigningSummaryReviewModel(safeTransaction())
  expect(safeModel.title).toBe('Safe transaction')
  expect(sensitiveOperationCategory(safeTransaction())).toBe('account-control')
  expect(recognizedRows(safeModel)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Safe', value: permitSpender }),
      expect.objectContaining({ label: 'Operation', value: 'DelegateCall', tone: 'warning' }),
      expect.objectContaining({ label: 'Value', value: '5 wei' })
    ])
  )
  expect(recognizedRows(safeModel).some(row => row.value.includes('0x1234'))).toBe(false)
  expect(safeModel.sections.find(section => section.title === 'Typed data').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Message.data', value: 'bytes · 0x1234' })
    ])
  )
})

test('rejects altered canonical typed-data domains, signers, fields, and array lengths', () => {
  const seaport = recognizedSummary({
    primaryType: 'OrderComponents',
    domain: seaportDomain,
    types: seaportTypes,
    message: seaportMessage
  })
  const reordered = structuredClone(seaport)
  reordered.fields.message.fields.reverse()
  const fixedOffer = recognizedSummary({
    primaryType: 'OrderComponents',
    domain: seaportDomain,
    types: seaportTypes,
    digestTypes: {
      ...seaportTypes,
      OrderComponents: seaportTypes.OrderComponents.map(field =>
        field.name === 'offer' ? { ...field, type: 'OfferItem[1]' } : field
      )
    },
    message: seaportMessage
  })
  const fixedWitness = recognizedSummary({
    primaryType: 'PermitBatchWitnessTransferFrom',
    domain: permit2Domain,
    types: {
      TokenPermissions: tokenPermissionFields,
      ExampleTrade: exampleTrade,
      PermitBatchWitnessTransferFrom: witnessFields('TokenPermissions[]')
    },
    digestTypes: {
      TokenPermissions: tokenPermissionFields,
      ExampleTrade: exampleTrade,
      PermitBatchWitnessTransferFrom: witnessFields('TokenPermissions[2]')
    },
    message: {
      permitted: [
        { token: permitToken, amount: 42n },
        { token: permitToken, amount: 42n }
      ],
      spender: permitSpender,
      nonce: 1n,
      deadline: 500n,
      witness: { receiver: permitSpender, minimum: 7n }
    }
  })
  for (const input of [
    recognizedSummary({
      primaryType: 'OrderComponents',
      domain: { ...seaportDomain, version: '1.1' },
      types: seaportTypes,
      message: seaportMessage
    }),
    recognizedSummary({
      primaryType: 'OrderComponents',
      domain: { ...seaportDomain, verifyingContract: permitToken },
      types: seaportTypes,
      message: seaportMessage
    }),
    recognizedSummary({
      primaryType: 'OrderComponents',
      domain: seaportDomain,
      types: seaportTypes,
      message: seaportMessage,
      signer: permitSpender
    }),
    reordered,
    fixedOffer,
    recognizedSummary({
      primaryType: 'Permit',
      domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: permitToken },
      types: daiTypes,
      message: {
        holder: permitSpender,
        spender: permitSpender,
        nonce: 1n,
        expiry: 0n,
        allowed: true
      }
    }),
    recognizedSummary({
      primaryType: 'TransferWithAuthorization',
      domain: { salt: bytes32Value, verifyingContract: permitToken },
      types: { TransferWithAuthorization: transferAuthorization },
      message: {
        from: permitOwner,
        to: permitSpender,
        value: 42n,
        validAfter: 0n,
        validBefore: 500n,
        nonce: bytes32Value
      }
    }),
    recognizedSummary({
      primaryType: 'Order',
      domain: { name: 'Blur Exchange', version: '1.0', chainId: 1, verifyingContract: permitToken },
      types: blurTypes,
      message: blurMessage
    }),
    recognizedSummary({
      primaryType: 'SafeTx',
      domain: { name: 'Safe', chainId: 1, verifyingContract: permitSpender },
      types: safeTypes,
      message: safeMessage
    }),
    recognizedSummary({
      primaryType: 'Order',
      domain: {
        name: '1inch Aggregation Router',
        version: '6',
        chainId: 1,
        verifyingContract: inchRouter
      },
      types: inchTypes,
      message: {
        salt: 1n,
        maker: permitSpender,
        receiver: zeroAddress,
        makerAsset: permitToken,
        takerAsset: permitSpender,
        makingAmount: 5n,
        takingAmount: 6n,
        makerTraits: 0n
      }
    }),
    fixedWitness
  ]) {
    expect(decodeEvmTypedDataRecognition(input)).toBeNull()
  }
})

test('explains a Permit2 lockdown and a zero approval of Permit2', () => {
  const original = baseSummaries.find(item => item.schema === 'evm.transaction.v1')
  const word = value => value.toString(16).padStart(64, '0')
  const addressWord = address => address.slice(2).toLowerCase().padStart(64, '0')
  const spender = '0x3333333333333333333333333333333333333333'
  const revoke = `0x095ea7b3${addressWord(PERMIT2_CONTRACT)}${word(0)}`
  const revokeModel = buildSigningSummaryReviewModel({
    ...original,
    fields: {
      ...original.fields,
      valueWei: '0',
      calldata: content('hex', revoke),
      methodSelector: revoke.slice(0, 10)
    }
  })
  expect(revokeModel.description).toBe(PERMIT2_TOKEN_REVOKE_EFFECT)
  expect(revokeModel.tokenAuthorization).toMatchObject({ effect: 'revoke-permit2' })
  expect(revokeModel.sections.find(section => section.title === 'Calldata request').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Revoke effect', value: PERMIT2_TOKEN_REVOKE_EFFECT })
    ])
  )

  const lockdown = encodePermit2Lockdown([{ token: original.fields.to, spender }])
  const model = buildSigningSummaryReviewModel({
    ...original,
    fields: {
      ...original.fields,
      to: PERMIT2_CONTRACT,
      valueWei: '0',
      calldata: content('hex', lockdown),
      methodSelector: lockdown.slice(0, 10)
    }
  })
  expect(model.title).toBe('Clear Permit2 allowance')
  expect(model.description).toBe(PERMIT2_LOCKDOWN_EFFECT)
  expect(model.tokenAuthorization).toMatchObject({
    effect: 'lockdown',
    spender,
    tokens: [expect.objectContaining({ amount: 'Cleared', unlimited: false })]
  })
  const rows = model.sections.find(section => section.title === 'Calldata request').rows
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Requested method', value: 'Permit2.lockdown' }),
      expect.objectContaining({ label: 'Effect', value: 'Amount and expiration set to zero' })
    ])
  )
  expect(rows.some(row => row.value === 'Unlimited' || row.label === 'Requested allowance')).toBe(
    false
  )
})

function nearArgs(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value)
  return {
    encoding: 'base64',
    value: Buffer.from(json, 'utf8').toString('base64'),
    byteLength: Buffer.byteLength(json),
    sha256: digest
  }
}

function nearFunctionCall(methodName, args, receiverId = 'token.near', signerId = 'alice.near') {
  return summary('near.transaction.v1', 'near:mainnet', 'transaction', {
    signerId,
    publicKey: 'ed25519:public-key',
    nonce: '1',
    receiverId,
    blockHash: digest,
    actions: [
      {
        kind: 'function-call',
        methodName,
        args,
        gas: '30000000000000',
        depositYocto: '1'
      }
    ]
  })
}

function nearActionReviewRows(item) {
  return buildSigningSummaryReviewModel(item).sections.find(section =>
    section.title.startsWith('Actions')
  ).rows
}

test('decodes NEAR fungible transfers into recipient, amount, and token contract', () => {
  const transfer = nearActionReviewRows(
    nearFunctionCall(
      'ft_transfer',
      nearArgs({ receiver_id: 'bob.near', amount: '1000', memo: 'invoice' })
    )
  )
  const transferMethod = transfer.findIndex(row => row.label === 'Method')
  expect(transfer[transferMethod + 1]).toMatchObject({ label: 'Recipient', value: 'bob.near' })
  expect(transfer[transferMethod + 2]).toMatchObject({ label: 'Amount', value: '1000' })
  expect(transfer[transferMethod + 3]).toMatchObject({
    label: 'Token contract',
    value: 'token.near'
  })
  expect(transfer.some(row => row.label === 'Arguments')).toBe(true)

  const transferCall = nearActionReviewRows(
    nearFunctionCall(
      'ft_transfer_call',
      nearArgs({ receiver_id: 'defi.near', amount: '42', msg: 'swap' }),
      'token.near'
    )
  )
  expect(transferCall).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Recipient', value: 'defi.near' }),
      expect.objectContaining({ label: 'Amount', value: '42' }),
      expect.objectContaining({ label: 'Token contract', value: 'token.near' }),
      expect.objectContaining({
        label: 'Arguments',
        value: nearArgs({ receiver_id: 'defi.near', amount: '42', msg: 'swap' }).value
      })
    ])
  )

  for (const contractId of ['wrap.near', 'wrap.testnet']) {
    const wrapped = nearActionReviewRows(
      nearFunctionCall(
        'ft_transfer',
        nearArgs({ receiver_id: 'bob.near', amount: '1500000000000000000000000' }),
        contractId
      )
    )
    expect(wrapped.find(row => row.label === 'Amount')).toMatchObject({
      value: '1.5 wNEAR',
      title: '1500000000000000000000000'
    })
    expect(wrapped.find(row => row.label === 'Token contract')).toMatchObject({ value: contractId })
  }
})

test('decodes NEAR NFT transfer and approval subjects', () => {
  const transfer = nearActionReviewRows(
    nearFunctionCall(
      'nft_transfer',
      nearArgs({ receiver_id: 'bob.near', token_id: 'token-1', memo: 'gift' })
    )
  )
  const transferMethod = transfer.findIndex(row => row.label === 'Method')
  expect(transfer[transferMethod + 1]).toMatchObject({ label: 'Recipient', value: 'bob.near' })
  expect(transfer[transferMethod + 2]).toMatchObject({ label: 'Token ID', value: 'token-1' })
  expect(transfer.some(row => row.label === 'Amount')).toBe(false)

  const approval = nearActionReviewRows(
    nearFunctionCall('nft_approve', nearArgs({ token_id: 'token-1', account_id: 'market.near' }))
  )
  const approvalMethod = approval.findIndex(row => row.label === 'Method')
  expect(approval[approvalMethod + 1]).toMatchObject({
    label: 'Approved account',
    value: 'market.near'
  })
  expect(approval[approvalMethod + 2]).toMatchObject({ label: 'Token ID', value: 'token-1' })
  expect(approval.some(row => row.label === 'Recipient' || row.label === 'Amount')).toBe(false)
  expect(approval.some(row => row.label === 'Arguments')).toBe(true)
})

test('decodes NEAR storage and native withdrawals to the signer', () => {
  const storage = nearActionReviewRows(
    nearFunctionCall(
      'storage_withdraw',
      nearArgs({ amount: '1000000000000000000000000' }),
      'token.near',
      'alice.near'
    )
  )
  expect(storage.find(row => row.label === 'Recipient')).toMatchObject({ value: 'alice.near' })
  expect(storage.find(row => row.label === 'Amount')).toMatchObject({
    value: '1 NEAR',
    title: '1000000000000000000000000'
  })

  for (const args of [{}, { amount: null }]) {
    const available = nearActionReviewRows(nearFunctionCall('storage_withdraw', nearArgs(args)))
    const amount = available.find(row => row.label === 'Amount')
    expect(amount).toMatchObject({ value: 'All available' })
    expect(amount.title).toBeUndefined()
    expect(available.find(row => row.label === 'Recipient')).toMatchObject({ value: 'alice.near' })
  }

  const unwrap = nearActionReviewRows(
    nearFunctionCall(
      'near_withdraw',
      nearArgs({ amount: '2500000000000000000000000' }),
      'wrap.near'
    )
  )
  expect(unwrap.find(row => row.label === 'Recipient')).toMatchObject({ value: 'alice.near' })
  expect(unwrap.find(row => row.label === 'Amount')).toMatchObject({
    value: '2.5 NEAR',
    title: '2500000000000000000000000'
  })
  expect(unwrap.some(row => row.label === 'Arguments')).toBe(true)
})

test('keeps raw NEAR arguments when a known method payload cannot be decoded', () => {
  const payloads = [
    nearFunctionCall('ft_transfer', nearArgs('{')),
    nearFunctionCall('ft_transfer', nearArgs({ receiver_id: 'Bob.near', amount: '1' })),
    nearFunctionCall('ft_transfer', nearArgs({ receiver_id: 'bob.near', amount: 1 })),
    nearFunctionCall('ft_transfer', {
      encoding: 'base64',
      value: '!!!',
      byteLength: 1,
      sha256: digest
    })
  ]
  for (const payload of payloads) {
    const rows = nearActionReviewRows(payload)
    expect(rows.some(row => row.label === 'Recipient' || row.label === 'Amount')).toBe(false)
    expect(rows.some(row => row.label === 'Arguments')).toBe(true)
  }
})
