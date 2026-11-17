import { WNEAR_NEAR_ASSET } from '@/config/intents'
import type { RheaSwapTransactionBinding } from '@/core/transactions/domain'

import type { RheaSwapNearTransactionBatchPlan } from './rhea-swap-model'

export const NEAR_WRAP_CONTRACT_ID = 'wrap.near'
export const NEAR_WRAP_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n

const NEAR_WRAP_ACTION_GAS = '50000000000000'
const MAXIMUM_BATCH_TRANSACTIONS = 16
const MAXIMUM_ACTIONS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function actionMethodName(action: unknown): string | null {
  if (!isRecord(action)) return null
  if (action.type === 'FunctionCall' && isRecord(action.params)) {
    return typeof action.params.methodName === 'string' ? action.params.methodName : null
  }
  if (action.enum === 'functionCall' && isRecord(action.functionCall)) {
    return typeof action.functionCall.methodName === 'string'
      ? action.functionCall.methodName
      : null
  }
  return typeof action.methodName === 'string' ? action.methodName : null
}

function functionCall(
  methodName: string,
  args: Readonly<Record<string, unknown>>,
  deposit: string
) {
  return Object.freeze({
    type: 'FunctionCall' as const,
    params: Object.freeze({
      methodName,
      args,
      gas: NEAR_WRAP_ACTION_GAS,
      deposit
    })
  })
}

function spendsNativeWrappedNear(binding: RheaSwapTransactionBinding): boolean {
  return (
    binding.origin.protocolChainId === 'near' &&
    binding.origin.protocolAssetId === WNEAR_NEAR_ASSET &&
    binding.origin.assetId.endsWith('/slip44:397')
  )
}

export function attachNativeNearWrap(
  plan: RheaSwapNearTransactionBatchPlan,
  binding: RheaSwapTransactionBinding
): RheaSwapNearTransactionBatchPlan {
  if (!spendsNativeWrappedNear(binding)) return plan
  if (!/^[1-9][0-9]*$/.test(binding.originAmountRaw)) {
    throw new Error('RHEA Swap NEAR wrap amount is invalid')
  }
  if (
    plan.transactions.some(transaction =>
      transaction.actions.some(action => actionMethodName(action) === 'near_deposit')
    )
  ) {
    return plan
  }
  const wrapActions = Object.freeze([
    functionCall(
      'storage_deposit',
      Object.freeze({ account_id: binding.sender, registration_only: true }),
      NEAR_WRAP_STORAGE_DEPOSIT_YOCTO.toString()
    ),
    functionCall('near_deposit', Object.freeze({}), binding.originAmountRaw)
  ])
  const wrapIndex = plan.transactions.findIndex(
    transaction => transaction.receiverId === NEAR_WRAP_CONTRACT_ID
  )
  if (
    wrapIndex >= 0 &&
    plan.transactions[wrapIndex].actions.length + wrapActions.length <= MAXIMUM_ACTIONS
  ) {
    return Object.freeze({
      ...plan,
      transactions: Object.freeze(
        plan.transactions.map((transaction, index) =>
          index === wrapIndex
            ? Object.freeze({
                ...transaction,
                actions: Object.freeze([...wrapActions, ...transaction.actions])
              })
            : transaction
        )
      )
    })
  }
  if (plan.transactions.length >= MAXIMUM_BATCH_TRANSACTIONS) {
    throw new Error('RHEA Swap NEAR batch cannot include a NEAR wrap')
  }
  return Object.freeze({
    ...plan,
    transactions: Object.freeze([
      Object.freeze({
        signerId: binding.sender,
        receiverId: NEAR_WRAP_CONTRACT_ID,
        actions: wrapActions
      }),
      ...plan.transactions
    ])
  })
}
