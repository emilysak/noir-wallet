import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionData, parseAbi } from 'viem'

import { EvmRpcError } from '../../../../src/infrastructure/chains/evm/evm-rpc-client.ts'
import {
  ERC20_ALLOWANCE_REVOKE_UNAVAILABLE,
  selectErc20RevokeCall
} from '../../../../src/infrastructure/chains/evm/evm-token-revoke.ts'

const token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const owner = '0x1111111111111111111111111111111111111111'
const spender = '0x2222222222222222222222222222222222222222'
const revokeAbi = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function decreaseAllowance(address spender, uint256 amount)'
])
const approveData = encodeFunctionData({
  abi: revokeAbi,
  functionName: 'approve',
  args: [spender, 0n]
})
const decreaseData = encodeFunctionData({
  abi: revokeAbi,
  functionName: 'decreaseAllowance',
  args: [spender, 42n]
})
const trueWord = `0x${'0'.repeat(63)}1`
const falseWord = `0x${'0'.repeat(64)}`

function revert(code = 3, message = 'execution reverted') {
  return new EvmRpcError('rpc-error', 'EVM RPC request failed', { code, message }, 'eth_call')
}

function selector() {
  const calls = []
  return {
    calls,
    run: (ethCall, allowance = '42') =>
      selectErc20RevokeCall({
        token,
        owner,
        spender,
        readAllowance: async () => {
          calls.push('allowance')
          return allowance
        },
        ethCall: async call => {
          calls.push(call)
          return ethCall(call)
        }
      })
  }
}

test('treats an empty approve return as success and sends the call from the owner', async () => {
  const harness = selector()
  await assert.doesNotReject(async () => {
    const selected = await harness.run(async call => {
      assert.equal(call.from, owner)
      assert.equal(call.to, token)
      assert.equal(call.valueRaw, '0')
      assert.equal(call.data, approveData)
      return '0x'
    })
    assert.deepEqual(selected, { method: 'approve', data: approveData })
  })
  assert.equal(harness.calls.filter(call => typeof call === 'object').length, 1)
})

test('accepts a 32-byte true approve return', async () => {
  const selected = await selectErc20RevokeCall({
    token,
    owner,
    spender,
    readAllowance: async () => '42',
    ethCall: async () => trueWord.toUpperCase()
  })
  assert.deepEqual(selected, { method: 'approve', data: approveData })
})

test('uses decreaseAllowance when approve(spender, 0) reverts, including an empty decrease return', async () => {
  const calls = []
  const selected = await selectErc20RevokeCall({
    token,
    owner,
    spender,
    readAllowance: async () => '42',
    ethCall: async call => {
      calls.push(call.data)
      if (call.data === approveData) throw revert()
      assert.equal(call.from, owner)
      assert.equal(call.data, decreaseData)
      return '0x'
    }
  })
  assert.deepEqual(calls, [approveData, decreaseData])
  assert.deepEqual(selected, { method: 'decreaseAllowance', data: decreaseData })
})

test('does not use a false or unexpected approve return', async () => {
  for (const result of [falseWord, '0x1234', '0x01']) {
    const calls = []
    const selected = await selectErc20RevokeCall({
      token,
      owner,
      spender,
      readAllowance: async () => '42',
      ethCall: async call => {
        calls.push(call.data)
        return call.data === approveData ? result : trueWord
      }
    })
    assert.deepEqual(selected, { method: 'decreaseAllowance', data: decreaseData })
    assert.deepEqual(calls, [approveData, decreaseData])
  }
})

test('does not try decreaseAllowance when the approve probe is not an execution revert', async () => {
  const calls = []
  await assert.rejects(
    selectErc20RevokeCall({
      token,
      owner,
      spender,
      readAllowance: async () => '42',
      ethCall: async call => {
        calls.push(call.data)
        throw new EvmRpcError('timeout', 'EVM RPC request timed out', undefined, 'eth_call')
      }
    }),
    /timed out/
  )
  assert.deepEqual(calls, [approveData])

  calls.length = 0
  await assert.rejects(
    selectErc20RevokeCall({
      token,
      owner,
      spender,
      readAllowance: async () => '42',
      ethCall: async call => {
        calls.push(call.data)
        throw revert(-32_603, 'header not found')
      }
    }),
    /EVM RPC request failed/
  )
  assert.deepEqual(calls, [approveData])
})

test('does not produce calldata when neither revoke call succeeds', async () => {
  await assert.rejects(
    selectErc20RevokeCall({
      token,
      owner,
      spender,
      readAllowance: async () => '42',
      ethCall: async call => {
        if (call.data === approveData) throw revert(-32_000, 'execution reverted')
        return falseWord
      }
    }),
    new Error(ERC20_ALLOWANCE_REVOKE_UNAVAILABLE)
  )
  await assert.rejects(
    selectErc20RevokeCall({
      token,
      owner,
      spender,
      readAllowance: async () => '42',
      ethCall: async () => {
        throw revert()
      }
    }),
    new Error(ERC20_ALLOWANCE_REVOKE_UNAVAILABLE)
  )
})

test('does not call the token when the allowance is already zero', async () => {
  const calls = []
  await assert.rejects(
    selectErc20RevokeCall({
      token,
      owner,
      spender,
      readAllowance: async () => '0',
      ethCall: async call => {
        calls.push(call)
        return '0x'
      }
    }),
    /already zero/
  )
  assert.deepEqual(calls, [])
})
