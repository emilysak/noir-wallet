import type { NearActionSummary, SigningSummary } from '@/core/keyring/domain/signing-summary'
import {
  decodeEvmAccountControlCall,
  decodeEvmAuthorizationCall
} from '@/infrastructure/chains/evm/evm-contract-call-classification'
import { decodeEvmTypedDataRecognition } from '@/infrastructure/chains/evm/evm-typed-data-recognition'

export type SensitiveOperationCategory = 'authorization' | 'account-control'

/** Operation judgment. A clear site list does not make an operation verified. */
export type SecurityJudgment = 'unknown' | 'warn' | 'clear' | 'block'

export interface ReviewActionPresentation {
  readonly rejectVariant: 'default' | 'outline'
  readonly confirmVariant: 'default' | 'outline' | 'secondary'
  readonly rejectAutoFocus: boolean
  readonly confirmRequiresSecondStep: boolean
}

export const UNKNOWN_SENSITIVE_CONFIRMATION = Object.freeze({
  title: 'Confirm unverified action',
  message:
    'This authorization or account-control request has not been verified. Reject it unless you have checked the destination and the permissions it changes.',
  confirmText: 'Continue',
  cancelText: 'Back'
})

const NEAR_ACCOUNT_CONTROL_KINDS = new Set<NearActionSummary['kind']>([
  'create-account',
  'deploy-contract',
  'stake',
  'add-key',
  'delete-key',
  'delete-account'
])

export function resolveSensitiveOperationCategory(
  categories: readonly (SensitiveOperationCategory | null)[]
): SensitiveOperationCategory | null {
  let authorization = false
  for (const category of categories) {
    if (category === 'account-control') return 'account-control'
    if (category === 'authorization') authorization = true
  }
  return authorization ? 'authorization' : null
}

function evmCalldata(summary: SigningSummary): string | undefined {
  if (summary.schema !== 'evm.transaction.v1') return undefined
  const calldata = summary.fields.calldata
  return calldata.encoding === 'hex' ? calldata.value : undefined
}

function typedDataCategory(
  summary: Extract<SigningSummary, { schema: 'evm.typed-data.v1' }>
): SensitiveOperationCategory | null {
  const recognized = decodeEvmTypedDataRecognition(summary)
  switch (recognized?.kind) {
    case 'permit':
    case 'eip3009-transfer':
    case 'seaport':
    case 'blur':
    case 'receiver-order':
      return 'authorization'
    case 'safe-tx':
      return 'account-control'
    case 'eip3009-cancel':
    case undefined:
      return null
    default: {
      const unsupported: never = recognized
      return unsupported
    }
  }
}

export function sensitiveOperationCategory(
  summary: SigningSummary
): SensitiveOperationCategory | null {
  switch (summary.schema) {
    case 'evm.transaction.v1': {
      const calldata = evmCalldata(summary)
      return resolveSensitiveOperationCategory([
        decodeEvmAccountControlCall(calldata) ? 'account-control' : null,
        decodeEvmAuthorizationCall(calldata, summary.fields.to) ? 'authorization' : null
      ])
    }
    case 'evm.typed-data.v1':
      return typedDataCategory(summary)
    case 'tron.transaction.v1': {
      const contract = summary.fields.contract
      return resolveSensitiveOperationCategory([
        contract.type === 'trigger-smart-contract' &&
        contract.interpretation.kind === 'trc20-approve'
          ? 'authorization'
          : null
      ])
    }
    case 'near.transaction.v1':
      return resolveSensitiveOperationCategory(
        summary.fields.actions.map(action =>
          NEAR_ACCOUNT_CONTROL_KINDS.has(action.kind) ? 'account-control' : null
        )
      )
    case 'zcash.transaction.v1':
    case 'zcash.message.v1':
    case 'evm.personal-message.v1':
    case 'bitcoin.psbt.v1':
    case 'bitcoin.bip322-message.v1':
    case 'solana.transaction.v1':
    case 'solana.message.v1':
    case 'tron.sign-message-v2.v1':
    case 'near.nep413-message.v1':
      return null
    default: {
      const unsupported: never = summary
      return unsupported
    }
  }
}

export function requiresUnknownSensitiveConfirmation(
  category: SensitiveOperationCategory | null,
  judgment: SecurityJudgment
): boolean {
  return judgment === 'unknown' && (category === 'authorization' || category === 'account-control')
}

export function reviewActionPresentation(input: {
  readonly blocked: boolean
  readonly category: SensitiveOperationCategory | null
  readonly judgment: SecurityJudgment
}): ReviewActionPresentation {
  if (input.blocked || input.judgment === 'block') {
    return {
      rejectVariant: 'outline',
      confirmVariant: 'secondary',
      rejectAutoFocus: false,
      confirmRequiresSecondStep: false
    }
  }
  if (requiresUnknownSensitiveConfirmation(input.category, input.judgment)) {
    return {
      rejectVariant: 'default',
      confirmVariant: 'outline',
      rejectAutoFocus: true,
      confirmRequiresSecondStep: true
    }
  }
  return {
    rejectVariant: 'outline',
    confirmVariant: 'default',
    rejectAutoFocus: false,
    confirmRequiresSecondStep: false
  }
}
