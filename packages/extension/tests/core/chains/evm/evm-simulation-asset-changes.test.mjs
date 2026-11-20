import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateEvmSimulationAssetChanges,
  readEvmSimulationTransfers
} from '../../../../src/core/chains/evm/evm-simulation-asset-changes.ts'
import { buildSigningSummaryReviewModel } from '../../../../src/popup/components/signing/signing-summary-review-model.ts'

const account = '0x1111111111111111111111111111111111111111'
const counterparty = '0x2222222222222222222222222222222222222222'
const firstUsdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const secondUsdc = '0x3333333333333333333333333333333333333333'
const firstUsdcKey = firstUsdc.toLowerCase()
const secondUsdcKey = secondUsdc.toLowerCase()

const usdcMetadata = [
  { contractAddress: firstUsdc, symbol: 'USDC', decimals: 6, verification: 'trusted' },
  { contractAddress: secondUsdc, symbol: 'USDC', decimals: 6, verification: 'user-approved' }
]

function token(contractAddress, from, to, amountRaw) {
  return { contractAddress, from, to, amountRaw }
}

test('keeps tokens with the same symbol separate by contract address', () => {
  const changes = aggregateEvmSimulationAssetChanges({
    account,
    tokenTransfers: [
      token(firstUsdc, account, counterparty, '100'),
      token(secondUsdc, counterparty, account, '40')
    ],
    tokens: usdcMetadata
  })

  assert.deepEqual(changes, [
    {
      kind: 'token',
      contractAddress: secondUsdcKey,
      direction: 'incoming',
      amountRaw: '40',
      verification: 'user-approved',
      symbol: 'USDC',
      decimals: 6
    },
    {
      kind: 'token',
      contractAddress: firstUsdcKey,
      direction: 'outgoing',
      amountRaw: '100',
      verification: 'trusted',
      symbol: 'USDC',
      decimals: 6
    }
  ])
})

test('keeps an unverified metadata symbol as a reported name and ignores a symbol on the transfer', () => {
  const changes = aggregateEvmSimulationAssetChanges({
    account,
    tokenTransfers: [
      token(secondUsdc, account, counterparty, '5'),
      token(firstUsdc, account, counterparty, '9'),
      { ...token(firstUsdc, counterparty, account, '1'), symbol: 'USDC' }
    ],
    tokens: [
      {
        contractAddress: secondUsdc,
        symbol: 'REAL',
        decimals: 18,
        verification: 'unverified'
      },
      {
        contractAddress: firstUsdc,
        symbol: 'BAD\u200b',
        decimals: 6,
        verification: 'unverified'
      }
    ]
  })

  assert.deepEqual(changes, [
    {
      kind: 'token',
      contractAddress: secondUsdcKey,
      direction: 'outgoing',
      amountRaw: '5',
      verification: 'unverified',
      reportedName: 'REAL'
    },
    {
      kind: 'token',
      contractAddress: firstUsdcKey,
      direction: 'outgoing',
      amountRaw: '9',
      verification: 'unverified'
    }
  ])
  assert.equal(
    changes.some(change => change.reportedName === 'USDC' || change.symbol === 'USDC'),
    false
  )
})

test('nets several transfers of one contract and drops a zero balance', () => {
  const changes = aggregateEvmSimulationAssetChanges({
    account,
    tokenTransfers: [
      token(firstUsdc, account, counterparty, '100'),
      token(firstUsdc, counterparty, account, '30'),
      token(firstUsdc, account, account, '10'),
      token(secondUsdc, account, counterparty, '4'),
      token(secondUsdc, counterparty, account, '4'),
      token(firstUsdc, counterparty, '0x4444444444444444444444444444444444444444', '7')
    ],
    tokens: usdcMetadata
  })

  assert.deepEqual(changes, [
    {
      kind: 'token',
      contractAddress: firstUsdcKey,
      direction: 'outgoing',
      amountRaw: '70',
      verification: 'trusted',
      symbol: 'USDC',
      decimals: 6
    }
  ])
})

test('uses traceTransfers for the native net and ignores transaction value', () => {
  const withoutTraces = aggregateEvmSimulationAssetChanges({
    account,
    tokenTransfers: [token(secondUsdc, account, counterparty, '1')],
    valueWei: '12'
  })
  assert.deepEqual(
    withoutTraces.map(change => change.kind),
    ['token']
  )

  const changes = aggregateEvmSimulationAssetChanges({
    account,
    traceTransfers: [
      { from: account, to: counterparty, valueWei: '12' },
      { from: counterparty, to: account, valueWei: '4' },
      { from: account, to: account, valueWei: '100' },
      {
        from: counterparty,
        to: '0x4444444444444444444444444444444444444444',
        valueWei: '9'
      }
    ]
  })

  assert.deepEqual(changes, [
    { kind: 'native', direction: 'outgoing', amountRaw: '8' }
  ])
  assert.equal(
    aggregateEvmSimulationAssetChanges({
      account,
      traceTransfers: []
    }).length,
    0
  )
})

test('rejects a simulation payload that tries to supply native value directly', () => {
  assert.equal(readEvmSimulationTransfers(undefined), undefined)
  assert.equal(
    readEvmSimulationTransfers({
      traceTransfers: [{ from: account, to: counterparty, valueWei: '12' }],
      valueWei: '12'
    }),
    undefined
  )

  const transfers = readEvmSimulationTransfers({
    traceTransfers: [{ from: account, to: counterparty, valueWei: '12' }]
  })
  assert.deepEqual(aggregateEvmSimulationAssetChanges({ account, ...transfers }), [
    { kind: 'native', direction: 'outgoing', amountRaw: '12' }
  ])
})

test('review shows traced asset changes and keeps transaction value separate', () => {
  const summary = {
    schema: 'evm.transaction.v1',
    chainId: 'eip155:1',
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      transactionType: 'eip1559',
      from: account,
      to: counterparty,
      nonce: '1',
      valueWei: '12',
      gasLimit: '21000',
      maximumFeeWei: '2',
      gasPriceWei: null,
      maxFeePerGasWei: '1',
      maxPriorityFeePerGasWei: '1',
      accessList: [],
      calldata: { encoding: 'hex', value: '0x', byteLength: 1, sha256: '00'.repeat(32) },
      methodSelector: null
    }
  }
  const presentation = {
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    tokenMetadata: [usdcMetadata[0]]
  }
  const untouched = buildSigningSummaryReviewModel(summary, presentation)
  assert.equal(
    untouched.sections.some(section => section.title === 'Asset changes'),
    false
  )
  assert.equal(
    untouched.sections.find(section => section.title === 'Transaction')?.rows.some(row => row.label === 'Value'),
    true
  )

  const reviewed = buildSigningSummaryReviewModel(summary, {
    ...presentation,
    simulationTransfers: {
      tokenTransfers: [token(secondUsdc, account, counterparty, '5')],
      traceTransfers: [
        { from: account, to: counterparty, valueWei: '12' },
        { from: counterparty, to: account, valueWei: '4' }
      ]
    }
  })
  const assetChanges = reviewed.sections.find(section => section.title === 'Asset changes')
  assert.equal(reviewed.sections[0]?.title, 'Asset changes')
  assert.deepEqual(
    assetChanges?.rows.map(row => [row.label, row.value]),
    [
      ['ETH', '−0.000000000000000008 ETH'],
      ['Unverified', `−5\n${secondUsdcKey}`]
    ]
  )
  assert.equal(assetChanges?.rows[1]?.title, secondUsdcKey)

  const named = buildSigningSummaryReviewModel(summary, {
    ...presentation,
    tokenMetadata: usdcMetadata,
    simulationTransfers: {
      tokenTransfers: [
        token(firstUsdc, account, counterparty, '1000000'),
        token(secondUsdc, counterparty, account, '4000000')
      ],
      traceTransfers: []
    }
  })
  const namedChanges = named.sections.find(section => section.title === 'Asset changes')
  assert.deepEqual(
    namedChanges?.rows.map(row => [row.label, row.value]),
    [
      ['Self-reported', `USDC\n+4 USDC\n${secondUsdcKey}`],
      ['USDC', '−1 USDC']
    ]
  )
  assert.equal(namedChanges?.rows[0]?.title, secondUsdcKey)
  assert.equal(namedChanges?.rows[1]?.title, firstUsdcKey)
  assert.equal(
    reviewed.sections.find(section => section.title === 'Transaction')?.rows.some(row => row.label === 'Value'),
    true
  )
})
