import { parseNearAccountId } from '@/core/chains/near'
import type { CanonicalContent } from '@/core/keyring/domain'
import { base64ToBytes } from '@/lib/bytes'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'

import { reviewRow, type SigningSummaryReviewRow } from './signing-summary-review-model-types'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const NEAR_DECIMALS = 24
const MAXIMUM_TOKEN_ID_LENGTH = 1024
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/
const TOKEN_ID_CONTROLS = /[\u0000-\u001f\u007f]/
const WNEAR_CONTRACTS = new Set(['wrap.near', 'wrap.testnet'])

export interface NearFunctionCallReviewContext {
  readonly signerId: string
  readonly tokenContractId: string
}

type FungibleTransfer = {
  readonly kind: 'fungible-transfer'
  readonly recipientId: string
  readonly amountRaw: string
}

type NftTransfer = {
  readonly kind: 'nft-transfer'
  readonly recipientId: string
  readonly tokenId: string
}

type NftApproval = {
  readonly kind: 'nft-approve'
  readonly accountId: string
  readonly tokenId: string
}

type StorageWithdraw = {
  readonly kind: 'storage-withdraw'
  readonly amountRaw: string | null
}

type NearWithdraw = {
  readonly kind: 'near-withdraw'
  readonly amountRaw: string
}

type DecodedNearFunctionCall =
  | FungibleTransfer
  | NftTransfer
  | NftApproval
  | StorageWithdraw
  | NearWithdraw

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function allowsKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[]
): boolean {
  const keys = Object.keys(record)
  return keys.every(key => allowed.includes(key)) && required.every(key => own(record, key))
}

function parseU128(value: unknown): string | undefined {
  if (typeof value !== 'string' || !UNSIGNED_DECIMAL.test(value)) return undefined
  const amount = BigInt(value)
  if (amount > MAXIMUM_U128) return undefined
  return value
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return !own(record, key) || typeof record[key] === 'string'
}

function optionalApprovalId(record: Record<string, unknown>): boolean {
  if (!own(record, 'approval_id') || record.approval_id === null) return true
  const value = record.approval_id
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  if (typeof value !== 'string' || !UNSIGNED_DECIMAL.test(value)) return false
  return BigInt(value) <= MAXIMUM_U64
}

function parseAccount(value: unknown): string | undefined {
  try {
    return parseNearAccountId(value)
  } catch {
    return undefined
  }
}

function parseTokenId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_TOKEN_ID_LENGTH) {
    return undefined
  }
  if (TOKEN_ID_CONTROLS.test(value)) return undefined
  return value
}

function argumentText(args: CanonicalContent): string | undefined {
  if (args.encoding === 'utf8') return args.value
  if (args.encoding !== 'base64') return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(args.value))
  } catch {
    return undefined
  }
}

function argumentRecord(args: CanonicalContent): Record<string, unknown> | undefined {
  const text = argumentText(args)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function decodeFungibleTransfer(
  args: Record<string, unknown>,
  allowed: readonly string[],
  requiresMessage: boolean
): FungibleTransfer | undefined {
  if (!allowsKeys(args, allowed, ['receiver_id', 'amount']) || !optionalString(args, 'memo')) {
    return undefined
  }
  if (requiresMessage && (!own(args, 'msg') || typeof args.msg !== 'string')) return undefined
  const recipientId = parseAccount(args.receiver_id)
  const amountRaw = parseU128(args.amount)
  if (recipientId === undefined || amountRaw === undefined) return undefined
  return { kind: 'fungible-transfer', recipientId, amountRaw }
}

function decodeNearFunctionCall(
  methodName: string,
  args: Record<string, unknown>
): DecodedNearFunctionCall | undefined {
  switch (methodName) {
    case 'ft_transfer':
      return decodeFungibleTransfer(args, ['receiver_id', 'amount', 'memo'], false)
    case 'ft_transfer_call':
      return decodeFungibleTransfer(args, ['receiver_id', 'amount', 'memo', 'msg'], true)
    case 'nft_transfer': {
      if (
        !allowsKeys(
          args,
          ['receiver_id', 'token_id', 'approval_id', 'memo'],
          ['receiver_id', 'token_id']
        ) ||
        !optionalString(args, 'memo') ||
        !optionalApprovalId(args)
      ) {
        return undefined
      }
      const recipientId = parseAccount(args.receiver_id)
      const tokenId = parseTokenId(args.token_id)
      if (recipientId === undefined || tokenId === undefined) return undefined
      return { kind: 'nft-transfer', recipientId, tokenId }
    }
    case 'nft_approve': {
      if (
        !allowsKeys(args, ['token_id', 'account_id', 'msg'], ['token_id', 'account_id']) ||
        !optionalString(args, 'msg')
      ) {
        return undefined
      }
      const accountId = parseAccount(args.account_id)
      const tokenId = parseTokenId(args.token_id)
      if (accountId === undefined || tokenId === undefined) return undefined
      return { kind: 'nft-approve', accountId, tokenId }
    }
    case 'storage_withdraw': {
      if (!allowsKeys(args, ['amount'], [])) return undefined
      if (!own(args, 'amount') || args.amount === null) {
        return { kind: 'storage-withdraw', amountRaw: null }
      }
      const amountRaw = parseU128(args.amount)
      if (amountRaw === undefined) return undefined
      return { kind: 'storage-withdraw', amountRaw }
    }
    case 'near_withdraw': {
      if (!allowsKeys(args, ['amount'], ['amount'])) return undefined
      const amountRaw = parseU128(args.amount)
      if (amountRaw === undefined) return undefined
      return { kind: 'near-withdraw', amountRaw }
    }
    default:
      return undefined
  }
}

function accountRow(label: string, accountId: string): SigningSummaryReviewRow {
  return reviewRow(label, accountId, { code: true, breakAll: true })
}

function rawAmountRow(amountRaw: string): SigningSummaryReviewRow {
  return reviewRow('Amount', amountRaw, { code: true, breakAll: true })
}

function formattedAmountRow(amountRaw: string, symbol: 'NEAR' | 'wNEAR'): SigningSummaryReviewRow {
  return reviewRow('Amount', `${formatBaseUnitDecimalAmount(amountRaw, NEAR_DECIMALS)} ${symbol}`, {
    code: true,
    breakAll: true,
    title: amountRaw
  })
}

function reviewRows(
  decoded: DecodedNearFunctionCall,
  context: NearFunctionCallReviewContext
): readonly SigningSummaryReviewRow[] {
  switch (decoded.kind) {
    case 'fungible-transfer':
      // Unknown fungible contracts stay in raw units. Only canonical wNEAR has fixed decimals here.
      return [
        accountRow('Recipient', decoded.recipientId),
        WNEAR_CONTRACTS.has(context.tokenContractId)
          ? formattedAmountRow(decoded.amountRaw, 'wNEAR')
          : rawAmountRow(decoded.amountRaw),
        accountRow('Token contract', context.tokenContractId)
      ]
    case 'nft-transfer':
      return [
        accountRow('Recipient', decoded.recipientId),
        reviewRow('Token ID', decoded.tokenId, { code: true, breakAll: true })
      ]
    case 'nft-approve':
      return [
        accountRow('Approved account', decoded.accountId),
        reviewRow('Token ID', decoded.tokenId, { code: true, breakAll: true })
      ]
    case 'storage-withdraw':
    case 'near-withdraw': {
      // These methods refund the predecessor account, which is the transaction signer.
      const recipientId = parseAccount(context.signerId)
      if (recipientId === undefined) return []
      return [
        accountRow('Recipient', recipientId),
        decoded.amountRaw === null
          ? reviewRow('Amount', 'All available')
          : formattedAmountRow(decoded.amountRaw, 'NEAR')
      ]
    }
  }
}

export function nearFunctionCallReviewRows(
  methodName: string,
  args: CanonicalContent,
  context: NearFunctionCallReviewContext
): readonly SigningSummaryReviewRow[] {
  const record = argumentRecord(args)
  if (record === undefined) return []
  const decoded = decodeNearFunctionCall(methodName, record)
  if (decoded === undefined) return []
  return reviewRows(decoded, context)
}
