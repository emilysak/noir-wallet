const RAW_AMOUNT = /^(0|[1-9][0-9]*)$/

export interface ConstraintAmount {
  readonly assetId: string
  readonly amountRaw: string
}

export interface ConstraintRecipient {
  readonly chainId: string
  readonly address: string
}

/** User authorization for a wallet-built transaction. The signed payload is bound separately. */
export interface ConstraintExecutionBinding {
  readonly kind: 'constraint'
  readonly maxSpend: ConstraintAmount
  readonly recipients: readonly ConstraintRecipient[]
  readonly maxFee: ConstraintAmount
  readonly expiresAt: number
}

export interface ObservedConstraintExecution {
  readonly spend: ConstraintAmount
  readonly recipients: readonly ConstraintRecipient[]
  readonly fee: ConstraintAmount
}

export const CONSTRAINT_EXECUTION_MESSAGES = Object.freeze({
  spend: 'Approved spend changed. Review the transaction again.',
  recipient: 'Recipient changed. Review the transaction again.',
  fee: 'Network fee changed. Review the transaction again.',
  expired: 'Review expired. Review the transaction again.'
})

export function isQuoteExecutionProtocol(provider: string | undefined): boolean {
  return provider === 'rhea-cross-chain-dex' || provider === 'near-intents'
}

export function reviewedAmountAllows(actualRaw: string, reviewedRaw: string | undefined): boolean {
  if (reviewedRaw === undefined || !RAW_AMOUNT.test(actualRaw) || !RAW_AMOUNT.test(reviewedRaw)) {
    return false
  }
  return BigInt(actualRaw) <= BigInt(reviewedRaw)
}

function parseRawAmount(value: string, message: string): bigint {
  if (!RAW_AMOUNT.test(value)) throw new Error(message)
  return BigInt(value)
}

function sameRecipientAddress(left: string, right: string): boolean {
  if (/^0x/i.test(left) || /^0x/i.test(right)) return left.toLowerCase() === right.toLowerCase()
  return left === right
}

export function assertFeeWithinCeiling(
  actualRaw: string,
  maximumRaw: string,
  message: string = CONSTRAINT_EXECUTION_MESSAGES.fee
): void {
  if (parseRawAmount(actualRaw, message) > parseRawAmount(maximumRaw, message)) {
    throw new Error(message)
  }
}

/**
 * Accept a rebuilt shield, quote source, or coin selection when the result stays
 * inside the reviewed ceilings. Change outputs are omitted by the caller.
 */
export function assertWithinConstraintBinding(
  binding: ConstraintExecutionBinding,
  observed: ObservedConstraintExecution,
  now: number
): void {
  if (
    binding.kind !== 'constraint' ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(binding.expiresAt) ||
    now >= binding.expiresAt
  ) {
    throw new Error(CONSTRAINT_EXECUTION_MESSAGES.expired)
  }
  if (observed.spend.assetId !== binding.maxSpend.assetId) {
    throw new Error(CONSTRAINT_EXECUTION_MESSAGES.spend)
  }
  if (
    parseRawAmount(observed.spend.amountRaw, CONSTRAINT_EXECUTION_MESSAGES.spend) >
    parseRawAmount(binding.maxSpend.amountRaw, CONSTRAINT_EXECUTION_MESSAGES.spend)
  ) {
    throw new Error(CONSTRAINT_EXECUTION_MESSAGES.spend)
  }
  if (observed.fee.assetId !== binding.maxFee.assetId) {
    throw new Error(CONSTRAINT_EXECUTION_MESSAGES.fee)
  }
  if (
    parseRawAmount(observed.fee.amountRaw, CONSTRAINT_EXECUTION_MESSAGES.fee) >
    parseRawAmount(binding.maxFee.amountRaw, CONSTRAINT_EXECUTION_MESSAGES.fee)
  ) {
    throw new Error(CONSTRAINT_EXECUTION_MESSAGES.fee)
  }
  for (const recipient of observed.recipients) {
    const allowed = binding.recipients.some(
      candidate =>
        candidate.chainId === recipient.chainId &&
        sameRecipientAddress(candidate.address, recipient.address)
    )
    if (!allowed) throw new Error(CONSTRAINT_EXECUTION_MESSAGES.recipient)
  }
}

/** Payment recipient only. A change output that returns to the wallet is not a new recipient. */
export function assertBitcoinSelectionWithinConstraint(input: {
  readonly binding: ConstraintExecutionBinding
  readonly chainId: string
  readonly assetId: string
  readonly recipient: string
  readonly amountSats: string
  readonly feeSats: string
  readonly now: number
}): void {
  assertWithinConstraintBinding(
    input.binding,
    {
      spend: { assetId: input.assetId, amountRaw: input.amountSats },
      recipients: [{ chainId: input.chainId, address: input.recipient }],
      fee: { assetId: input.assetId, amountRaw: input.feeSats }
    },
    input.now
  )
}
