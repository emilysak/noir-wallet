import { WALLET_CONFIG, ZEC_DECIMALS } from '@/config/wallet'
import { safeBig } from '@/lib/big'
import { formatBaseUnitDecimalAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import type { ZcashBalance } from '@/types'
import type { WasmTransactionEntry } from '@/core/worker/types'

type ShieldingBalance = string | number | null | undefined

export const MIN_SHIELDING_BALANCE_MESSAGE = `At least ${WALLET_CONFIG.SHIELDING_THRESHOLD} ZEC of confirmed transparent funds is required to shield.`

export const SHIELD_BALANCE_CHANGED_MESSAGE =
  'Transparent balance changed. Review the shield request again.'

const ZATOSHI_AMOUNT = /^(0|[1-9][0-9]*)$/

/** Zatoshis the user reviewed. dApp shielding spends this full balance or asks again. */
export function transparentShieldAmountZats(amount: string): string {
  let zats: string
  try {
    zats = parseDisplayUnitAmount(amount, ZEC_DECIMALS)
  } catch {
    throw new Error('Approved shield amount is unavailable. Review the shield request again.')
  }
  if (!ZATOSHI_AMOUNT.test(zats)) {
    throw new Error('Approved shield amount is unavailable. Review the shield request again.')
  }
  return zats
}

/**
 * The one-click builder spends the full shieldable balance and cannot take an
 * outpoint allowlist. The approved zatoshis are a maximum: a smaller balance
 * stays authorized, and a larger balance has to be reviewed again.
 */
export function assertApprovedShieldAmount(
  approvedAmountZats: string,
  currentAmountZats: string
): void {
  if (!ZATOSHI_AMOUNT.test(approvedAmountZats) || !ZATOSHI_AMOUNT.test(currentAmountZats)) {
    throw new Error('Approved shield amount is unavailable. Review the shield request again.')
  }
  if (BigInt(currentAmountZats) > BigInt(approvedAmountZats)) {
    throw new Error(SHIELD_BALANCE_CHANGED_MESSAGE)
  }
}

export function hasEnoughTransparentBalanceToShield(balance: ShieldingBalance): boolean {
  return safeBig(balance).gte(WALLET_CONFIG.SHIELDING_THRESHOLD)
}

export function getShieldableTransparentBalance(balance: ZcashBalance | null | undefined): string {
  if (!balance) return '0'
  if (balance.shieldable != null) return safeBig(balance.shieldable).toFixed()

  const confirmedFallback = safeBig(balance.transparent).minus(balance.pending?.transparent ?? '0')
  return confirmedFallback.gt(0) ? confirmedFallback.toFixed() : '0'
}

export function canShieldTransparentFunds(balance: ZcashBalance | null | undefined): boolean {
  return hasEnoughTransparentBalanceToShield(getShieldableTransparentBalance(balance))
}

function wasmTxidToHex(txid: number[]): string {
  return Array.from(txid)
    .reverse()
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function getShieldInputAmountFromHistory(
  entries: WasmTransactionEntry[],
  txid: string
): string | null {
  const normalizedTxid = txid.toLowerCase()
  const entry = entries.find(
    transaction =>
      transaction.kind === 'shield' &&
      wasmTxidToHex(transaction.txid).toLowerCase() === normalizedTxid
  )
  if (!entry) return null

  const inputZatoshis = safeBig(entry.amount_zatoshis).plus(entry.fee_zatoshis ?? 0)
  return inputZatoshis.gt(0)
    ? formatBaseUnitDecimalAmount(inputZatoshis.toFixed(), ZEC_DECIMALS)
    : null
}
