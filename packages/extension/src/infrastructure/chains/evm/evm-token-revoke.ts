import { encodeFunctionData, parseAbi } from 'viem'
import { EvmRpcError } from './evm-rpc-client'

const revokeAbi = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function decreaseAllowance(address spender, uint256 amount)'
])

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/
const rawAmountPattern = /^(0|[1-9][0-9]*)$/
const MAX_UINT256 = (1n << 256n) - 1n
const OPTIONAL_BOOL_TRUE = `0x${'0'.repeat(63)}1`

export const ERC20_ALLOWANCE_REVOKE_UNAVAILABLE = 'This token allowance cannot be revoked.'

export interface Erc20RevokeEthCall {
  readonly from: string
  readonly to: string
  readonly valueRaw: '0'
  readonly data: string
}

export interface Erc20RevokeCall {
  readonly method: 'approve' | 'decreaseAllowance'
  readonly data: string
}

export async function selectErc20RevokeCall(input: {
  readonly token: string
  readonly owner: string
  readonly spender: string
  readonly readAllowance: () => Promise<string>
  readonly ethCall: (call: Erc20RevokeEthCall) => Promise<string>
}): Promise<Erc20RevokeCall> {
  if (
    ![input.token, input.owner, input.spender].every(address => evmAddressPattern.test(address))
  ) {
    throw new Error('Invalid EVM allowance address')
  }
  const allowanceRaw = await input.readAllowance()
  const allowance = parseAllowance(allowanceRaw)
  if (allowance === 0n) throw new Error('ERC-20 allowance is already zero')

  const spender = input.spender as `0x${string}`
  // Omit the bool return. Tokens such as USDT succeed with empty return data.
  const approveData = encodeFunctionData({
    abi: revokeAbi,
    functionName: 'approve',
    args: [spender, 0n]
  })
  if (await probe(input, approveData)) {
    return Object.freeze({ method: 'approve', data: approveData })
  }

  // Some tokens revert on approve(spender, 0). Subtracting the current allowance clears it.
  const decreaseData = encodeFunctionData({
    abi: revokeAbi,
    functionName: 'decreaseAllowance',
    args: [spender, allowance]
  })
  if (await probe(input, decreaseData)) {
    return Object.freeze({ method: 'decreaseAllowance', data: decreaseData })
  }
  throw new Error(ERC20_ALLOWANCE_REVOKE_UNAVAILABLE)
}

function parseAllowance(value: string): bigint {
  if (!rawAmountPattern.test(value)) throw new Error('Invalid ERC-20 allowance')
  const amount = BigInt(value)
  if (amount > MAX_UINT256) throw new Error('Invalid ERC-20 allowance')
  return amount
}

async function probe(
  input: {
    readonly token: string
    readonly owner: string
    readonly ethCall: (call: Erc20RevokeEthCall) => Promise<string>
  },
  data: string
): Promise<boolean> {
  try {
    const result = await input.ethCall({
      from: input.owner,
      to: input.token,
      valueRaw: '0',
      data
    })
    if (typeof result !== 'string') throw new Error('Invalid EVM contract call response')
    return optionalBoolSuccess(result)
  } catch (error) {
    if (isExecutionRevert(error)) return false
    throw error
  }
}

function optionalBoolSuccess(result: string): boolean {
  const value = result.toLowerCase()
  return value === '0x' || value === OPTIONAL_BOOL_TRUE
}

function isExecutionRevert(error: unknown): boolean {
  if (!(error instanceof EvmRpcError) || error.code !== 'rpc-error') return false
  if (error.rpcCode === 3) return true
  return (error.rpcMessage ?? '').toLowerCase().includes('revert')
}
