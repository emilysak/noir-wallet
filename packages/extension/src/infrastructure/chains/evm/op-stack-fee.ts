import { isOpStackExecutionFee } from '@/config/networks'
import type { ChainId } from '@/core/chains/domain'
import { encodeFunctionData, type Hex } from 'viem'
import type { EvmPreparedTransaction } from './evm-transaction-builder'
import { EvmRpcError, type EvmTransactionRpc } from './evm-rpc-client'
import { serializeEvmUnsignedTransaction } from './evm-signed-transaction'

export class OpStackFeeError extends Error {
  readonly code: 'unavailable' | 'overflow'

  constructor(code: 'unavailable' | 'overflow', message: string) {
    super(message)
    this.name = 'OpStackFeeError'
    this.code = code
  }
}

const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F'
const MAXIMUM_UINT256 = (1n << 256n) - 1n
const L1_DATA_FEE_BUFFER = 2n

const GAS_PRICE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getL1Fee',
    stateMutability: 'view',
    inputs: [{ name: '_data', type: 'bytes' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'getOperatorFee',
    stateMutability: 'view',
    inputs: [{ name: '_gasUsed', type: 'uint256' }],
    outputs: [{ type: 'uint256' }]
  }
] as const

function readUint256(value: string): bigint | null {
  if (!/^0x(?:[0-9a-fA-F]{2}){0,32}$/.test(value)) return null
  return value === '0x' ? 0n : BigInt(value)
}

function unavailable(message: string): never {
  throw new OpStackFeeError('unavailable', message)
}

export async function quoteOpStackL1DataFee(input: {
  readonly chainId: ChainId
  readonly transaction: EvmPreparedTransaction
  readonly rpc: Pick<EvmTransactionRpc, 'callContract'>
  readonly signal?: AbortSignal
}): Promise<bigint> {
  if (!isOpStackExecutionFee(input.chainId)) return 0n
  const callContract = input.rpc.callContract
  if (callContract === undefined) unavailable('OP Stack L1 data fee is unavailable')
  const unsignedTransaction = serializeEvmUnsignedTransaction(input.transaction)
  let oracleFee: bigint
  try {
    oracleFee =
      readUint256(
        await callContract(
          OP_GAS_PRICE_ORACLE,
          encodeFunctionData({
            abi: GAS_PRICE_ORACLE_ABI,
            functionName: 'getL1Fee',
            args: [unsignedTransaction as Hex]
          }),
          input.signal
        )
      ) ?? unavailable('OP Stack L1 data fee is unavailable')
  } catch (error) {
    if (error instanceof OpStackFeeError) throw error
    if (error instanceof EvmRpcError && error.code !== 'rpc-error') throw error
    unavailable('OP Stack L1 data fee is unavailable')
  }
  let operatorFee = 0n
  try {
    const quoted = readUint256(
      await callContract(
        OP_GAS_PRICE_ORACLE,
        encodeFunctionData({
          abi: GAS_PRICE_ORACLE_ABI,
          functionName: 'getOperatorFee',
          args: [BigInt(input.transaction.gasLimit)]
        }),
        input.signal
      )
    )
    if (quoted === null) unavailable('OP Stack L1 data fee is unavailable')
    operatorFee = quoted
  } catch (error) {
    if (!(error instanceof EvmRpcError) || error.code !== 'rpc-error') throw error
  }
  const l1DataFee = oracleFee * L1_DATA_FEE_BUFFER + operatorFee
  if (l1DataFee > MAXIMUM_UINT256) {
    throw new OpStackFeeError('overflow', 'OP Stack data fee exceeds signer limits')
  }
  return l1DataFee
}
