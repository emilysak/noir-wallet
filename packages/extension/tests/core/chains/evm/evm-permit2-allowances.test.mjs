import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionResult, parseAbi } from 'viem'
import { PERMIT2_CONTRACT } from '../../../../src/infrastructure/chains/evm/evm-contract-call-classification.ts'
import {
  decodePermit2AllowanceResult,
  PERMIT2_APPROVAL_TOPIC,
  PERMIT2_PERMIT_TOPIC
} from '../../../../src/infrastructure/chains/evm/evm-permit2-allowance.ts'
import {
  collectPermit2Allowances,
  nextPermit2ScanRange,
  permit2PairsFromLogs
} from '../../../../src/infrastructure/chains/evm/evm-permit2-allowances.ts'
import { EvmRpcError } from '../../../../src/infrastructure/chains/evm/evm-rpc-client.ts'

const owner = '0x1111111111111111111111111111111111111111'
const token = '0x3333333333333333333333333333333333333333'
const spender = '0x2222222222222222222222222222222222222222'
const otherSpender = '0x4444444444444444444444444444444444444444'
const unknownToken = '0x5555555555555555555555555555555555555555'
const allowanceAbi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
])

function pad(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
}

test('decodes a Permit2 allowance word triple and rejects a short return', () => {
  const data = encodeFunctionResult({
    abi: allowanceAbi,
    functionName: 'allowance',
    result: [5n, 2000n, 1n]
  })
  assert.deepEqual(decodePermit2AllowanceResult(data), {
    amountRaw: '5',
    expirationRaw: '2000',
    nonceRaw: '1'
  })
  assert.throws(() => decodePermit2AllowanceResult(`${data}00`), /Invalid Permit2 allowance/)
  assert.throws(() => decodePermit2AllowanceResult(`0x${'f'.repeat(192)}`))
})

test('builds token and spender pairs from Approval and Permit logs', () => {
  const pairs = permit2PairsFromLogs(
    [
      {
        address: PERMIT2_CONTRACT.toUpperCase(),
        topics: [PERMIT2_APPROVAL_TOPIC, pad(owner), pad(token), pad(spender)]
      },
      {
        address: PERMIT2_CONTRACT,
        topics: [PERMIT2_PERMIT_TOPIC, pad(owner), pad(token), pad(otherSpender)]
      },
      {
        address: PERMIT2_CONTRACT,
        topics: [PERMIT2_APPROVAL_TOPIC, pad(spender), pad(token), pad(otherSpender)]
      },
      {
        address: token,
        topics: [PERMIT2_APPROVAL_TOPIC, pad(owner), pad(token), pad(spender)]
      }
    ],
    owner
  )
  assert.deepEqual(pairs, [
    { token, spender },
    { token, spender: otherSpender }
  ])
})

test('scans the chain tip before older Permit2 history', () => {
  assert.deepEqual(
    nextPermit2ScanRange(
      { deploymentBlock: '10', highCovered: null, lowPending: null },
      25n,
      10n
    ),
    { from: 16n, to: 25n, kind: 'history' }
  )
  assert.deepEqual(
    nextPermit2ScanRange({ deploymentBlock: '10', highCovered: '25', lowPending: '15' }, 30n, 10n),
    { from: 26n, to: 30n, kind: 'tip' }
  )
  assert.deepEqual(
    nextPermit2ScanRange({ deploymentBlock: '10', highCovered: '25', lowPending: '15' }, 25n, 10n),
    { from: 10n, to: 15n, kind: 'history' }
  )
  assert.equal(
    nextPermit2ScanRange({ deploymentBlock: '10', highCovered: '25', lowPending: '-1' }, 25n, 10n),
    null
  )
})

test('reads a token approval and the stored Permit2 allowance after the log scan', async () => {
  const logs = [
    {
      address: PERMIT2_CONTRACT,
      topics: [PERMIT2_APPROVAL_TOPIC, pad(owner), pad(token), pad(spender)]
    },
    {
      address: PERMIT2_CONTRACT,
      topics: [PERMIT2_PERMIT_TOPIC, pad(owner), pad(unknownToken), pad(spender)]
    },
    {
      address: PERMIT2_CONTRACT,
      topics: [PERMIT2_PERMIT_TOPIC, pad(owner), pad(token), pad(otherSpender)]
    }
  ]
  let saved = null
  const signal = new AbortController().signal
  let chain
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const chains = await collectPermit2Allowances({
      signal,
      networkMode: 'mainnet',
      owner,
      chains: [{ chainId: 'eip155:1', rpcOrigin: 'builtin' }],
      tokens: [
        {
          chainId: 'eip155:1',
          contractAddress: token,
          symbol: 'USDC',
          decimals: 6,
          trusted: true
        }
      ],
      store: {
        read: async () => saved,
        write: async value => {
          saved = value
        }
      },
      reader: () => ({
        getBlockHeader: async () => ({ number: '4', timestamp: '1000' }),
        getCodeAt: async (_address, blockNumber) => (BigInt(blockNumber) >= 2n ? '0x6000' : '0x'),
        getLogs: async query => {
          assert.equal(query.address, PERMIT2_CONTRACT)
          assert.deepEqual(query.topics[0], [PERMIT2_APPROVAL_TOPIC, PERMIT2_PERMIT_TOPIC])
          assert.equal(query.topics[1], pad(owner))
          return logs
        },
        readErc20Allowance: async (contract, allowanceOwner, allowanceSpender) => {
          assert.equal(allowanceOwner, owner)
          assert.equal(allowanceSpender, PERMIT2_CONTRACT)
          return contract === token ? '7' : '0'
        },
        readPermit2Allowance: async (_allowanceOwner, allowanceToken, allowanceSpender) => {
          if (allowanceToken === unknownToken) {
            return { amountRaw: '9', expirationRaw: '1', nonceRaw: '4' }
          }
          if (allowanceSpender === otherSpender) {
            return { amountRaw: '0', expirationRaw: '1', nonceRaw: '0' }
          }
          return { amountRaw: '5', expirationRaw: '2000', nonceRaw: '1' }
        }
      })
    })
    chain = chains[0]
    if (chain.status === 'ready') break
  }
  assert.equal(chain.status, 'ready')
  assert.deepEqual(chain.entries, [
    {
      kind: 'token-permit2',
      token,
      amountRaw: '7',
      unlimited: false,
      symbol: 'USDC',
      decimals: 6
    },
    {
      kind: 'internal',
      token,
      spender,
      amountRaw: '5',
      expirationRaw: '2000',
      expired: false,
      unlimited: false,
      symbol: 'USDC',
      decimals: 6
    },
    {
      kind: 'internal',
      token: unknownToken,
      spender,
      amountRaw: '9',
      expirationRaw: '1',
      expired: true,
      unlimited: false,
      symbol: null,
      decimals: null
    }
  ])
})

test('keeps a log scan incomplete when every chunk is rejected', async () => {
  let saved = null
  const signal = new AbortController().signal
  let chain
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const chains = await collectPermit2Allowances({
      signal,
      networkMode: 'mainnet',
      owner,
      chains: [{ chainId: 'eip155:1', rpcOrigin: 'user' }],
      tokens: [],
      store: {
        read: async () => saved,
        write: async value => {
          saved = value
        }
      },
      reader: () => ({
        getBlockHeader: async () => ({ number: '3', timestamp: '10' }),
        getCodeAt: async () => '0x6000',
        getLogs: async () => {
          throw new EvmRpcError('invalid-response', 'Log response was too large')
        },
        readErc20Allowance: async () => '0',
        readPermit2Allowance: async () => ({ amountRaw: '0', expirationRaw: '0', nonceRaw: '0' })
      })
    })
    chain = chains[0]
  }
  assert.equal(chain.status, 'incomplete')
  assert.equal(chain.rpcOrigin, 'user')
  assert.deepEqual(chain.entries, [])
})
