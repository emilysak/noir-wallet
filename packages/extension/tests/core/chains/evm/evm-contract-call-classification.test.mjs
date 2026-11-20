import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionData, parseAbi } from 'viem'
import {
  decodeEvmAuthorizationCall,
  evmContractCallReviewIssues,
  isErc20ApproveCalldata,
  isEvmAuthorizationCalldata,
  PERMIT2_CONTRACT
} from '../../../../src/infrastructure/chains/evm/evm-contract-call-classification.ts'
import { encodePermit2Lockdown } from '../../../../src/infrastructure/chains/evm/evm-permit2-allowance.ts'

const word = value => value.toString(16).padStart(64, '0')
const addressWord = address => address.slice(2).padStart(64, '0')

const spender = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'

test('recognizes authorization calls by selector without a trusted token list', () => {
  const approve = `0x095ea7b3${addressWord(spender)}${'f'.repeat(64)}`
  const increase = `0x39509351${addressWord(spender)}${word(42)}`
  const setAll = `0xa22cb465${addressWord(spender)}${word(1)}`
  const permit2 = `0x87517c45${addressWord(token)}${addressWord(spender)}${word(1_000)}${word(0)}`

  const decodedApprove = decodeEvmAuthorizationCall(approve, token)
  assert.equal(decodedApprove?.kind, 'erc20-approve')
  assert.equal(decodedApprove?.unlimited, true)

  assert.deepEqual(decodeEvmAuthorizationCall(increase, token), {
    kind: 'erc20-increase-allowance',
    spender,
    amountRaw: '42'
  })
  assert.deepEqual(decodeEvmAuthorizationCall(setAll, token), {
    kind: 'erc721-set-approval-for-all',
    operator: spender,
    approved: true
  })

  assert.equal(decodeEvmAuthorizationCall(permit2, token), null)
  const permit2Decoded = decodeEvmAuthorizationCall(permit2, PERMIT2_CONTRACT)
  assert.deepEqual(permit2Decoded, {
    kind: 'permit2-approve',
    token,
    spender,
    amountRaw: '1000',
    expirationRaw: '0',
    unlimited: false
  })
  assert.equal(isEvmAuthorizationCalldata(permit2, PERMIT2_CONTRACT), true)

  const unlimitedPermit2 = `0x87517c45${addressWord(token)}${addressWord(spender)}${word((1n << 160n) - 1n)}${word(1)}`
  assert.equal(decodeEvmAuthorizationCall(unlimitedPermit2, PERMIT2_CONTRACT)?.unlimited, true)
  assert.deepEqual(evmContractCallReviewIssues(unlimitedPermit2, PERMIT2_CONTRACT), [
    { code: 'token-approval' },
    { code: 'unlimited-token-approval' }
  ])
  assert.deepEqual(evmContractCallReviewIssues(permit2, token), [{ code: 'unrecognized-call' }])
})

test('binds EVM signing review issues to decoded authorization semantics', () => {
  const unlimitedApprove = `0x095ea7b3${addressWord(spender)}${'f'.repeat(64)}`
  assert.deepEqual(evmContractCallReviewIssues(unlimitedApprove, token), [
    { code: 'token-approval' },
    { code: 'unlimited-token-approval' }
  ])
  assert.deepEqual(evmContractCallReviewIssues(`0x39509351${addressWord(spender)}${word(1)}`, token), [
    { code: 'token-approval' }
  ])
  const decrease = encodeFunctionData({
    abi: parseAbi(['function decreaseAllowance(address spender, uint256 amount)']),
    functionName: 'decreaseAllowance',
    args: [spender, 42n]
  })
  assert.deepEqual(decodeEvmAuthorizationCall(decrease, token), {
    kind: 'erc20-decrease-allowance',
    spender,
    amountRaw: '42'
  })
  assert.equal(isEvmAuthorizationCalldata(decrease, token), true)
  assert.deepEqual(evmContractCallReviewIssues(decrease, token), [{ code: 'token-approval' }])
  assert.deepEqual(evmContractCallReviewIssues('0xdeadbeef', token), [{ code: 'unrecognized-call' }])
})

test('decodes one Permit2 lockdown pair and rejects a truncated or dirty encoding', () => {
  const lockdown = encodePermit2Lockdown([{ token, spender }])
  assert.equal(lockdown.slice(0, 10), '0xcc53287f')
  assert.deepEqual(decodeEvmAuthorizationCall(lockdown, PERMIT2_CONTRACT), {
    kind: 'permit2-lockdown',
    pairs: [{ token, spender }]
  })
  assert.deepEqual(evmContractCallReviewIssues(lockdown, PERMIT2_CONTRACT), [])
  assert.equal(isEvmAuthorizationCalldata(lockdown, PERMIT2_CONTRACT), true)
  assert.equal(isErc20ApproveCalldata(lockdown), false)
  assert.equal(decodeEvmAuthorizationCall(lockdown, token), null)
  assert.equal(decodeEvmAuthorizationCall(`${lockdown}${'0'.repeat(64)}`, PERMIT2_CONTRACT), null)
  assert.equal(decodeEvmAuthorizationCall(lockdown.slice(0, -2), PERMIT2_CONTRACT), null)
  const tokenWordStart = 2 + 8 + 64 * 2
  const dirty = `${lockdown.slice(0, tokenWordStart)}1${lockdown.slice(tokenWordStart + 1)}`
  assert.equal(decodeEvmAuthorizationCall(dirty, PERMIT2_CONTRACT), null)
  assert.equal(
    decodeEvmAuthorizationCall(
      `0xcc53287f${'0'.repeat(62)}20${'0'.repeat(64)}`,
      PERMIT2_CONTRACT
    ),
    null
  )
})