import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  evmDelegationTargetsFromNetworks,
  parseEvmAccountDelegationResult,
  readEvmDelegationDesignator,
  readEvmDelegationForTargets,
  summarizeEvmDelegation
} from '../../../../src/core/chains/evm/evm-delegation.ts'

const chainId = 'eip155:1'
const otherChainId = 'eip155:10'
const address = '0x1111111111111111111111111111111111111111'
const delegate = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const designator = `0xef0100${delegate.slice(2)}`

function chain(status, chain = chainId, delegateAddress) {
  return delegateAddress === undefined
    ? { chainId: chain, status }
    : { chainId: chain, status, delegate: delegateAddress }
}

it('reads an EIP-7702 designator and rejects every other code result', () => {
  assert.deepEqual(readEvmDelegationDesignator('0x'), { kind: 'absent' })
  assert.deepEqual(readEvmDelegationDesignator('0X'), { kind: 'absent' })
  assert.deepEqual(readEvmDelegationDesignator(designator), {
    kind: 'delegated',
    delegate
  })
  assert.deepEqual(readEvmDelegationDesignator(designator.toUpperCase()), {
    kind: 'delegated',
    delegate
  })
  assert.deepEqual(readEvmDelegationDesignator(`${designator}00`), { kind: 'other-code' })
  assert.deepEqual(readEvmDelegationDesignator(designator.slice(0, -2)), { kind: 'other-code' })
  assert.deepEqual(readEvmDelegationDesignator('0x6080604052'), { kind: 'other-code' })
  assert.deepEqual(readEvmDelegationDesignator('0x0'), { kind: 'other-code' })
  assert.deepEqual(readEvmDelegationDesignator(123), { kind: 'other-code' })
})

it('summarizes delegated before other code, and never treats a failed read as undelegated', () => {
  assert.equal(summarizeEvmDelegation([]), null)
  assert.equal(summarizeEvmDelegation([chain('absent')]), 'not-delegated')
  assert.equal(
    summarizeEvmDelegation([
      chain('delegated', chainId, delegate),
      chain('unavailable', otherChainId)
    ]),
    'delegated'
  )
  assert.equal(
    summarizeEvmDelegation([chain('other-code'), chain('unverified', otherChainId)]),
    'has-code'
  )
  assert.equal(
    summarizeEvmDelegation([chain('absent'), chain('unavailable', otherChainId)]),
    'unavailable'
  )
  assert.equal(
    summarizeEvmDelegation([chain('absent'), chain('unverified', otherChainId)]),
    'unverified'
  )
  assert.equal(summarizeEvmDelegation([chain('delegated')]), 'unavailable')
})

it('uses the main receive address and ignores the private execution address', () => {
  const privateAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  assert.deepEqual(
    evmDelegationTargetsFromNetworks([
      {
        chainId,
        privateExecutionAddress: privateAddress,
        addresses: [
          { value: address.toUpperCase(), scheme: 'evm', preferredForReceive: false },
          {
            value: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
            scheme: 'evm',
            preferredForReceive: true
          }
        ]
      },
      {
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        addresses: [
          {
            value: 'tb1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
            scheme: 'bitcoin',
            preferredForReceive: true
          }
        ]
      }
    ]),
    [{ chainId, address: '0xcccccccccccccccccccccccccccccccccccccccc' }]
  )
})

it('does not call a non-builtin node or turn a failed code read into not delegated', async () => {
  const calls = []
  const chains = await readEvmDelegationForTargets({
    signal: new AbortController().signal,
    targets: [
      { chainId, address },
      { chainId: otherChainId, address },
      { chainId: 'eip155:8453', address }
    ],
    networks: [
      { chainId, rpcOrigin: 'builtin' },
      { chainId: otherChainId, rpcOrigin: 'user' },
      { chainId: 'eip155:8453', rpcOrigin: 'builtin' }
    ],
    getCode: async (requestedChainId, requestedAddress) => {
      calls.push([requestedChainId, requestedAddress])
      if (requestedChainId === 'eip155:8453') throw new Error('rpc failed')
      return designator
    }
  })

  assert.deepEqual(calls, [
    [chainId, address],
    ['eip155:8453', address]
  ])
  assert.deepEqual(chains, [
    { chainId, status: 'delegated', delegate },
    { chainId: otherChainId, status: 'unverified' },
    { chainId: 'eip155:8453', status: 'unavailable' }
  ])
  assert.equal(summarizeEvmDelegation(chains), 'delegated')

  const unread = await readEvmDelegationForTargets({
    signal: new AbortController().signal,
    targets: [
      { chainId, address: null },
      { chainId: otherChainId, address }
    ],
    networks: [
      { chainId, rpcOrigin: 'builtin' },
      { chainId: otherChainId, rpcOrigin: 'dapp' }
    ],
    getCode: async () => '0x'
  })
  assert.equal(summarizeEvmDelegation(unread), 'unavailable')
  assert.notEqual(summarizeEvmDelegation(unread), 'not-delegated')
})

it('stops a code read when the request is aborted', async () => {
  const controller = new AbortController()
  const pending = readEvmDelegationForTargets({
    signal: controller.signal,
    targets: [{ chainId, address }],
    networks: [{ chainId, rpcOrigin: 'builtin' }],
    getCode: (_chainId, _address, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
  })
  controller.abort()
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
})

it('rejects a delegation result that is not an exact chain status', () => {
  const parsed = parseEvmAccountDelegationResult({
    available: true,
    chains: [{ chainId, status: 'delegated', delegate }]
  })
  assert.equal(parsed.chains[0].delegate, delegate)
  assert.throws(() =>
    parseEvmAccountDelegationResult({
      available: true,
      chains: [{ chainId, status: 'delegated' }]
    })
  )
  assert.throws(() =>
    parseEvmAccountDelegationResult({
      available: false,
      chains: [{ chainId, status: 'absent' }]
    })
  )
  assert.throws(() =>
    parseEvmAccountDelegationResult({
      available: true,
      chains: [{ chainId, status: 'absent', delegate }]
    })
  )
})
