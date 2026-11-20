import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toBytes } from 'viem'
import { PERMIT2_CONTRACT } from './evm-contract-call-classification'
import type { EvmContractRpc } from './evm-rpc-client'

const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function lockdown((address token, address spender)[] approvals)',
  'function approve(address spender, uint256 amount)'
])

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/
const MAX_UINT160 = (1n << 160n) - 1n
const MAX_UINT48 = (1n << 48n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n

export const PERMIT2_APPROVAL_TOPIC = keccak256(
  toBytes('Approval(address,address,address,uint160,uint48)')
)
export const PERMIT2_PERMIT_TOPIC = keccak256(
  toBytes('Permit(address,address,address,uint160,uint48,uint48)')
)

export interface Permit2InternalAllowance {
  readonly amountRaw: string
  readonly expirationRaw: string
  readonly nonceRaw: string
}

export function encodePermit2Lockdown(
  pairs: readonly { readonly token: string; readonly spender: string }[]
): string {
  if (pairs.length < 1 || pairs.length > 16) throw new Error('Invalid Permit2 lockdown')
  if (
    pairs.some(pair => !evmAddressPattern.test(pair.token) || !evmAddressPattern.test(pair.spender))
  ) {
    throw new Error('Invalid Permit2 lockdown')
  }
  return encodeFunctionData({
    abi: permit2Abi,
    functionName: 'lockdown',
    args: [
      pairs.map(pair => ({
        token: pair.token as `0x${string}`,
        spender: pair.spender as `0x${string}`
      }))
    ]
  })
}

export function encodeErc20Approve(spender: string, amountRaw: string): string {
  if (!evmAddressPattern.test(spender) || !/^(0|[1-9][0-9]*)$/.test(amountRaw)) {
    throw new Error('Invalid ERC-20 approval')
  }
  const amount = BigInt(amountRaw)
  if (amount > MAX_UINT256) throw new Error('Invalid ERC-20 approval')
  return encodeFunctionData({
    abi: permit2Abi,
    functionName: 'approve',
    args: [spender as `0x${string}`, amount]
  })
}

export function decodePermit2AllowanceResult(data: string): Permit2InternalAllowance {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || data.length !== 2 + 64 * 3) {
    throw new Error('Invalid Permit2 allowance')
  }
  const decoded = decodeFunctionResult({
    abi: permit2Abi,
    functionName: 'allowance',
    data: data as `0x${string}`
  })
  const [amount, expiration, nonce] = decoded
  if (amount > MAX_UINT160 || expiration > MAX_UINT48 || nonce > MAX_UINT48) {
    throw new Error('Invalid Permit2 allowance')
  }
  return Object.freeze({
    amountRaw: amount.toString(),
    expirationRaw: expiration.toString(),
    nonceRaw: nonce.toString()
  })
}

export async function readPermit2InternalAllowance(
  rpc: EvmContractRpc,
  owner: string,
  token: string,
  spender: string
): Promise<Permit2InternalAllowance> {
  if (![owner, token, spender].every(address => evmAddressPattern.test(address))) {
    throw new Error('Invalid Permit2 allowance address')
  }
  await rpc.assertExpectedChain()
  const result = await rpc.callContract(
    PERMIT2_CONTRACT,
    encodeFunctionData({
      abi: permit2Abi,
      functionName: 'allowance',
      args: [owner as `0x${string}`, token as `0x${string}`, spender as `0x${string}`]
    })
  )
  return decodePermit2AllowanceResult(result)
}

export function permit2AllowanceExpired(expirationRaw: string, blockTimestamp: string): boolean {
  return BigInt(expirationRaw) < BigInt(blockTimestamp)
}
