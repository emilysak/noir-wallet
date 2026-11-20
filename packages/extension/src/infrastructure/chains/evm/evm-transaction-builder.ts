import { isOpStackExecutionFee } from '@/config/networks'
import type { ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import { evmBytecodeHasRuntimeCode } from '@/core/chains/evm/evm-runtime-code'
import type { EvmTransactionSummary, SigningSummary } from '@/core/keyring/domain'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import {
  parseAssetId,
  parseChainId,
  type AssetRegistry,
  type AssetRegistryEntry
} from '@/core/chains/registry'
import { parseEvmAccountBinding } from './evm-account'
import {
  deriveEvmFeeTierQuote,
  deriveEvmLegacyFeeQuote,
  isPriorityFeeElevated,
  type EvmFeeSelection,
  type EvmFeeTierQuote
} from './evm-fee-tier'
import { OpStackFeeError, quoteOpStackL1DataFee } from './op-stack-fee'
import {
  EvmRpcError,
  type EvmBroadcastRpc,
  type EvmDAppReadRpc,
  type EvmRpcCall,
  type EvmTransactionRpc
} from './evm-rpc-client'
import { evmContractCallReviewIssues } from './evm-contract-call-classification'

const ETHEREUM_MAINNET_PRIORITY_FEE_FLOOR_WEI = 10_000_000n
const EVM_SIMPLE_TRANSFER_GAS = 21_000n
const EVM_DYNAMIC_GAS_MARGIN_BPS = 2_000n
const BASIS_POINTS = 10_000n

function minimumPriorityFeePerGas(
  chainId: ChainId,
  baseFeePerGas: bigint,
  suggestedGasPriceRaw?: string
): bigint | undefined {
  if (chainId === 'eip155:1') return ETHEREUM_MAINNET_PRIORITY_FEE_FLOOR_WEI
  if (chainId !== 'eip155:56' || suggestedGasPriceRaw === undefined) return undefined
  const suggestedGasPrice = parseRpcUint64(suggestedGasPriceRaw, 'EVM gas price')
  return suggestedGasPrice > baseFeePerGas ? suggestedGasPrice - baseFeePerGas : 0n
}

export const EVM_TRANSACTION_ERROR_CODES = Object.freeze([
  'invalid-intent',
  'insufficient-funds',
  'simulation-failed',
  'stale-nonce',
  'nonce-recovery-required',
  'nonce-queue-unavailable',
  'fee-overflow'
] as const)

export type EvmTransactionErrorCode = (typeof EVM_TRANSACTION_ERROR_CODES)[number]

export interface EvmInsufficientFundsDetails {
  readonly requiredNativeBalanceRaw: string
  readonly availableNativeBalanceRaw: string
  readonly shortfallRaw: string
  readonly maximumGasCostRaw: string
  readonly transactionValueRaw: string
}

export class EvmTransactionError extends Error {
  readonly code: EvmTransactionErrorCode
  readonly insufficientFunds?: EvmInsufficientFundsDetails
  readonly rpcFailure?: Readonly<{ code?: number; method?: string }>

  constructor(
    code: EvmTransactionErrorCode,
    message: string,
    insufficientFunds?: EvmInsufficientFundsDetails,
    rpcFailure?: Readonly<{ code?: number; method?: string }>
  ) {
    super(message)
    this.name = 'EvmTransactionError'
    this.code = code
    this.insufficientFunds = insufficientFunds
    this.rpcFailure = rpcFailure
  }
}

export interface EvmTransferIntent {
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
}

export interface EvmContractCallIntent {
  readonly chainId: ChainId
  readonly contractAddress: string
  readonly valueRaw: string
  readonly calldata: string
}

export interface EvmEip1559Transaction {
  readonly type: 'eip1559'
  readonly chainId: string
  readonly nonce: string
  readonly maxFeePerGas: string
  readonly maxPriorityFeePerGas: string
  readonly gasLimit: string
  readonly to: string
  readonly value: string
  readonly input: string
  readonly accessList: readonly never[]
}

export interface EvmLegacyTransaction {
  readonly type: 'legacy'
  readonly chainId: string
  readonly nonce: string
  readonly gasPrice: string
  readonly gasLimit: string
  readonly to: string
  readonly value: string
  readonly input: string
}

export type EvmPreparedTransaction = EvmEip1559Transaction | EvmLegacyTransaction

export interface PreparedEvmTransfer {
  readonly kind:
    | 'native-transfer'
    | 'erc20-transfer'
    | 'contract-call'
    | 'cancel'
    | 'nonce-recovery'
    | 'speed-up'
  readonly chainId: ChainId
  readonly addressIndex: number
  readonly from: string
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
  readonly observedBlockNumber: string
  readonly transaction: EvmPreparedTransaction
  readonly l1DataFeeWei: string
  readonly suggestedFeePerGasWei: string | null
  readonly priorityFeeElevated: boolean
  readonly createdAt: number
}

export interface EvmSigningPreparePayload {
  readonly kind: 'evm-transaction' | 'pea-evm-transaction'
  readonly chainId: ChainId
  readonly addressIndex: number
  readonly transaction: EvmPreparedTransaction
  readonly l1DataFeeWei: string
  readonly suggestedFeePerGasWei: string | null
  readonly priorityFeeElevated: boolean
}

export interface PeaEvmExecutionAccount {
  readonly kind: 'pea'
  readonly address: string
  readonly addressIndex: number
}

export interface BuildEvmTransferInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly intent: EvmTransferIntent
  readonly rpc: EvmTransactionRpc
  readonly feeSelection?: EvmFeeSelection
  readonly feeTier?: NetworkFeeTier
  readonly nonceFloor?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface BuildEvmContractCallInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly intent: EvmContractCallIntent
  readonly rpc: EvmTransactionRpc
  readonly feeSelection?: EvmFeeSelection
  readonly feeTier?: NetworkFeeTier
  readonly nonceFloor?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface EvmFeeEstimate {
  readonly chainId: ChainId
  readonly maximumFeeWei: string
  readonly maxFeePerGasWei: string
  readonly maxPriorityFeePerGasWei: string
  readonly gasLimit: string
  readonly transactionType?: 'eip1559' | 'legacy'
  readonly gasPriceWei?: string | null
  readonly amountIndependent?: boolean
  readonly l1DataFeeWei?: string
  readonly priorityFeeElevated?: boolean
}

export interface BuildEvmCancelInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly rpc: EvmTransactionRpc &
    Pick<EvmBroadcastRpc, 'getTransactionLocation'> &
    Pick<EvmDAppReadRpc, 'getTransactionCount'>
  readonly original: Readonly<{
    transactionHash: string
    nonce: string
    maxFeePerGasWei: string
    maxPriorityFeePerGasWei: string
  }>
  readonly allowUnknownAtNonce?: boolean
  readonly feeSelection?: EvmFeeSelection
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface BuildEvmSpeedUpInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly rpc: BuildEvmCancelInput['rpc']
  readonly original: Readonly<{
    transactionHash: string
    transaction: EvmPreparedTransaction
  }>
  readonly feeSelection?: EvmFeeSelection
  readonly allowUnknownAtNonce?: boolean
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface BuildEvmNonceRecoveryInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly assets: AssetRegistry
  readonly rpc: EvmTransactionRpc
  readonly nonce: string
  readonly feeSelection?: EvmFeeSelection
  readonly signal?: AbortSignal
  readonly now?: () => number
}

const MAXIMUM_UINT64 = (1n << 64n) - 1n
const MAXIMUM_UINT256 = (1n << 256n) - 1n
const ERC20_TRANSFER_SELECTOR = 'a9059cbb'
const ERC20_TRANSFER_CALLDATA_LENGTH = 2 + ERC20_TRANSFER_SELECTOR.length + 128
const ERC20_TRUE = `0x${'0'.repeat(63)}1`
export const EVM_SIMULATION_PREVIEW_TTL_MS = 30_000

function invalidIntent(message: string): never {
  throw new EvmTransactionError('invalid-intent', message)
}

function isInsufficientFundsRpcError(error: unknown): boolean {
  return (
    error instanceof EvmRpcError &&
    error.code === 'rpc-error' &&
    typeof error.rpcMessage === 'string' &&
    /insufficient funds|insufficient balance|funds for gas|exceeds (?:the )?account balance/i.test(
      error.rpcMessage
    )
  )
}

function insufficientFunds(details?: EvmInsufficientFundsDetails): never {
  throw new EvmTransactionError(
    'insufficient-funds',
    'The EVM balance does not cover the transfer and network fee',
    details
  )
}

function minimumFundingDetails(
  nativeBalance: bigint,
  transactionValue: bigint
): EvmInsufficientFundsDetails {
  const requiredNativeBalance =
    transactionValue > nativeBalance ? transactionValue : nativeBalance + 1n
  return Object.freeze({
    requiredNativeBalanceRaw: requiredNativeBalance.toString(),
    availableNativeBalanceRaw: nativeBalance.toString(),
    shortfallRaw: (requiredNativeBalance - nativeBalance).toString(),
    maximumGasCostRaw: '0',
    transactionValueRaw: transactionValue.toString()
  })
}

function parseRecipient(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    invalidIntent('Invalid EVM transfer recipient')
  }
  return value
}

function parseAmount(value: string, maximum: bigint, label: string): bigint {
  if (!/^[1-9][0-9]{0,77}$/.test(value)) invalidIntent(`Invalid ${label}`)
  const amount = BigInt(value)
  if (amount > maximum) invalidIntent(`Invalid ${label}`)
  return amount
}

function parseOptionalAmount(value: string, maximum: bigint, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) invalidIntent(`Invalid ${label}`)
  const amount = BigInt(value)
  if (amount > maximum) invalidIntent(`Invalid ${label}`)
  return amount
}

function parseCalldata(value: string): string {
  if (
    value.length < 4 ||
    value.length > 2 + 128 * 1024 * 2 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)
  ) {
    invalidIntent('Invalid EVM contract calldata')
  }
  return value.toLowerCase()
}

export function parseEvmTransferIntent(value: unknown): EvmTransferIntent {
  const record = readRecord(value, 'EVM transfer intent')
  assertExactKeys(record, ['assetId', 'recipient', 'amountRaw'], 'EVM transfer intent')
  if (
    typeof record.assetId !== 'string' ||
    typeof record.recipient !== 'string' ||
    typeof record.amountRaw !== 'string'
  ) {
    invalidIntent('Invalid EVM transfer intent')
  }
  return Object.freeze({
    assetId: parseAssetId(record.assetId).id,
    recipient: parseRecipient(record.recipient),
    amountRaw: parseAmount(record.amountRaw, MAXIMUM_UINT256, 'EVM transfer amount').toString()
  })
}

export function parseEvmContractCallIntent(value: unknown): EvmContractCallIntent {
  const record = readRecord(value, 'EVM contract call intent')
  assertExactKeys(
    record,
    ['chainId', 'contractAddress', 'valueRaw', 'calldata'],
    'EVM contract call intent'
  )
  if (
    typeof record.chainId !== 'string' ||
    typeof record.contractAddress !== 'string' ||
    typeof record.valueRaw !== 'string' ||
    typeof record.calldata !== 'string'
  ) {
    invalidIntent('Invalid EVM contract call intent')
  }
  const chain = parseChainId(record.chainId)
  if (chain.namespace !== 'eip155') invalidIntent('EVM contract call requires an EVM chain')
  return Object.freeze({
    chainId: chain.id,
    contractAddress: parseRecipient(record.contractAddress),
    valueRaw: parseOptionalAmount(
      record.valueRaw,
      MAXIMUM_UINT256,
      'EVM contract call value'
    ).toString(),
    calldata: parseCalldata(record.calldata)
  })
}

function parseRpcUint64(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  const amount = BigInt(value)
  if (amount > MAXIMUM_UINT64) {
    throw new EvmRpcError('invalid-response', `${label} exceeds the supported range`)
  }
  return amount
}

function gasLimitWithMargin(estimate: bigint, kind: PreparedEvmTransfer['kind']): bigint {
  if (kind === 'native-transfer' && estimate === EVM_SIMPLE_TRANSFER_GAS) return estimate
  const limit =
    (estimate * (BASIS_POINTS + EVM_DYNAMIC_GAS_MARGIN_BPS) + BASIS_POINTS - 1n) / BASIS_POINTS
  if (limit > MAXIMUM_UINT64) {
    throw new EvmTransactionError('fee-overflow', 'EVM gas limit exceeds signer limits')
  }
  return limit
}

function parseRpcUint256(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  const amount = BigInt(value)
  if (amount > MAXIMUM_UINT256) {
    throw new EvmRpcError('invalid-response', `${label} exceeds the supported range`)
  }
  return amount
}

function parseTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid EVM transaction timestamp')
  return value
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  optional: readonly string[] = []
): void {
  const allowed = new Set([...expected, ...optional])
  if (
    expected.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function readIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readRawAmount(value: unknown, label: string, maximum: bigint): string {
  const amount = readString(value, label, 78)
  if (!/^(0|[1-9][0-9]{0,77})$/.test(amount) || BigInt(amount) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return amount
}

function readEvmAddress(value: unknown, label: string): string {
  const address = readString(value, label, 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Invalid ${label}`)
  return address
}

function parsePersistedTransaction(value: unknown, chainId: ChainId): EvmPreparedTransaction {
  const record = readRecord(value, 'Prepared EVM transaction')
  const commonKeys = ['type', 'chainId', 'nonce', 'gasLimit', 'to', 'value', 'input']
  assertExactKeys(
    record,
    record.type === 'legacy'
      ? [...commonKeys, 'gasPrice']
      : [...commonKeys, 'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList'],
    'Prepared EVM transaction'
  )
  if (
    !['legacy', 'eip1559'].includes(String(record.type)) ||
    record.chainId !== chainId.slice('eip155:'.length)
  ) {
    throw new Error('Prepared EVM transaction chain does not match')
  }
  const nonce = readRawAmount(record.nonce, 'EVM nonce', MAXIMUM_UINT64)
  const gasLimit = readRawAmount(record.gasLimit, 'EVM gas limit', MAXIMUM_UINT64)
  if (gasLimit === '0') throw new Error('Prepared EVM transaction gas limit is invalid')
  const input = readString(record.input, 'EVM transaction input', 2 + 128 * 1024 * 2)
  if (!/^0x(?:[0-9a-f]{2})*$/.test(input)) throw new Error('Invalid EVM transaction input')
  const common = {
    chainId: record.chainId as string,
    nonce,
    gasLimit,
    to: readEvmAddress(record.to, 'EVM transaction recipient'),
    value: readRawAmount(record.value, 'EVM transaction value', MAXIMUM_UINT256),
    input
  }
  if (record.type === 'legacy') {
    const gasPrice = readRawAmount(record.gasPrice, 'EVM gas price', MAXIMUM_UINT64)
    if (gasPrice === '0') throw new Error('Prepared EVM transaction gas price is invalid')
    return Object.freeze({ type: 'legacy', ...common, gasPrice })
  }
  const maxFeePerGas = readRawAmount(record.maxFeePerGas, 'EVM maximum fee', MAXIMUM_UINT64)
  const maxPriorityFeePerGas = readRawAmount(
    record.maxPriorityFeePerGas,
    'EVM priority fee',
    MAXIMUM_UINT64
  )
  if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
    throw new Error('Prepared EVM transaction fee fields are invalid')
  }
  if (!Array.isArray(record.accessList) || record.accessList.length !== 0) {
    throw new Error('Prepared EVM transfer access list must be empty')
  }
  return Object.freeze({
    type: 'eip1559',
    ...common,
    maxFeePerGas,
    maxPriorityFeePerGas,
    accessList: Object.freeze([])
  })
}

export function parsePreparedEvmTransfer(value: unknown): PreparedEvmTransfer {
  const record = readRecord(value, 'Prepared EVM transfer')
  assertExactKeys(
    record,
    [
      'kind',
      'chainId',
      'addressIndex',
      'from',
      'assetId',
      'recipient',
      'amountRaw',
      'observedBlockNumber',
      'transaction',
      'createdAt'
    ],
    'Prepared EVM transfer',
    ['l1DataFeeWei', 'suggestedFeePerGasWei', 'priorityFeeElevated']
  )
  if (
    record.kind !== 'native-transfer' &&
    record.kind !== 'erc20-transfer' &&
    record.kind !== 'contract-call' &&
    record.kind !== 'cancel' &&
    record.kind !== 'nonce-recovery' &&
    record.kind !== 'speed-up'
  ) {
    throw new Error('Invalid prepared EVM transfer kind')
  }
  const chain = parseChainId(readString(record.chainId, 'EVM chain ID', 64))
  if (chain.namespace !== 'eip155') throw new Error('Prepared EVM transfer requires an EVM chain')
  const asset = parseAssetId(readString(record.assetId, 'EVM asset ID', 256))
  if (asset.chainId !== chain.id) throw new Error('Prepared EVM transfer asset chain mismatch')
  const recipient = readEvmAddress(record.recipient, 'EVM transfer recipient')
  const from = readEvmAddress(record.from, 'EVM transfer sender')
  if (/^0x0{40}$/i.test(recipient)) throw new Error('Invalid EVM transfer recipient')
  const amountRaw = readRawAmount(record.amountRaw, 'EVM transfer amount', MAXIMUM_UINT256)
  if (
    record.kind !== 'contract-call' &&
    record.kind !== 'cancel' &&
    record.kind !== 'nonce-recovery' &&
    record.kind !== 'speed-up' &&
    amountRaw === '0'
  ) {
    throw new Error('Prepared EVM transfer amount must be positive')
  }
  const transaction = parsePersistedTransaction(record.transaction, chain.id)
  const l1DataFeeWei =
    record.l1DataFeeWei === undefined
      ? '0'
      : readRawAmount(record.l1DataFeeWei, 'EVM L1 data fee', MAXIMUM_UINT256)
  const suggestedFeePerGasWei =
    record.suggestedFeePerGasWei === undefined || record.suggestedFeePerGasWei === null
      ? null
      : readRawAmount(record.suggestedFeePerGasWei, 'EVM suggested fee', MAXIMUM_UINT256)
  if (
    typeof record.priorityFeeElevated !== 'undefined' &&
    typeof record.priorityFeeElevated !== 'boolean'
  ) {
    throw new Error('Invalid EVM priority fee warning')
  }
  const priorityFeeElevated = record.priorityFeeElevated === true
  const chosenFeePerGasWei = BigInt(
    transaction.type === 'legacy' ? transaction.gasPrice : transaction.maxPriorityFeePerGas
  )
  if (
    (priorityFeeElevated && suggestedFeePerGasWei === null) ||
    (suggestedFeePerGasWei !== null &&
      priorityFeeElevated !==
        isPriorityFeeElevated(chosenFeePerGasWei, BigInt(suggestedFeePerGasWei)))
  ) {
    throw new Error('Invalid EVM priority fee warning')
  }
  if (record.kind === 'native-transfer') {
    if (
      asset.namespace !== 'slip44' ||
      transaction.to.toLowerCase() !== recipient.toLowerCase() ||
      transaction.value !== amountRaw ||
      transaction.input !== '0x'
    ) {
      throw new Error('Prepared native EVM transfer binding mismatch')
    }
  } else if (record.kind === 'erc20-transfer') {
    const expectedInput = `0x${ERC20_TRANSFER_SELECTOR}${recipient
      .slice(2)
      .padStart(64, '0')}${BigInt(amountRaw).toString(16).padStart(64, '0')}`
    if (
      asset.namespace !== 'erc20' ||
      transaction.to.toLowerCase() !== asset.reference.toLowerCase() ||
      transaction.value !== '0' ||
      transaction.input.toLowerCase() !== expectedInput.toLowerCase()
    ) {
      throw new Error('Prepared ERC-20 transfer binding mismatch')
    }
  } else if (record.kind === 'speed-up') {
    if (
      asset.namespace !== 'slip44' ||
      transaction.to.toLowerCase() !== recipient.toLowerCase() ||
      transaction.value !== amountRaw
    ) {
      throw new Error('Prepared EVM speed up binding mismatch')
    }
  } else if (record.kind === 'cancel' || record.kind === 'nonce-recovery') {
    if (
      asset.namespace !== 'slip44' ||
      recipient.toLowerCase() !== from.toLowerCase() ||
      transaction.to.toLowerCase() !== recipient.toLowerCase() ||
      transaction.value !== '0' ||
      transaction.input !== '0x'
    ) {
      throw new Error('Prepared EVM cancellation binding mismatch')
    }
  } else if (
    asset.namespace !== 'slip44' ||
    transaction.to.toLowerCase() !== recipient.toLowerCase() ||
    transaction.value !== amountRaw ||
    transaction.input === '0x'
  ) {
    throw new Error('Prepared EVM contract call binding mismatch')
  }
  return Object.freeze({
    kind: record.kind,
    chainId: chain.id,
    addressIndex: readIndex(record.addressIndex, 'EVM address index'),
    from,
    assetId: asset.id,
    recipient,
    amountRaw,
    observedBlockNumber: readRawAmount(
      record.observedBlockNumber,
      'EVM observed block number',
      MAXIMUM_UINT64
    ),
    transaction,
    l1DataFeeWei,
    suggestedFeePerGasWei,
    priorityFeeElevated,
    createdAt: parseTimestamp(record.createdAt as number)
  })
}

export function evmPreparedMaximumFeeWei(
  prepared: Pick<PreparedEvmTransfer, 'transaction' | 'l1DataFeeWei'>
): string {
  const transaction = prepared.transaction
  const executionFee =
    BigInt(transaction.gasLimit) *
    BigInt(transaction.type === 'legacy' ? transaction.gasPrice : transaction.maxFeePerGas)
  return (executionFee + BigInt(prepared.l1DataFeeWei ?? '0')).toString()
}

export async function computeEvmSigningPayloadFingerprint(
  value: EvmPreparedTransaction
): Promise<string> {
  const numericId = readRawAmount(value.chainId, 'EVM chain ID', MAXIMUM_UINT64)
  const transaction = parsePersistedTransaction(value, parseChainId(`eip155:${numericId}`).id)
  const canonical = Object.freeze({
    type: transaction.type,
    chainId: transaction.chainId,
    nonce: transaction.nonce,
    gasLimit: transaction.gasLimit,
    to: transaction.to,
    value: transaction.value,
    input: transaction.input,
    ...(transaction.type === 'legacy'
      ? { gasPrice: transaction.gasPrice }
      : {
          maxFeePerGas: transaction.maxFeePerGas,
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
          accessList: transaction.accessList
        })
  })
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical))
  )
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function computeHexContentSha256(value: string): Promise<string> {
  const bytes = new Uint8Array((value.length - 2) / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16)
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createEvmSigningSummary(
  prepared: PreparedEvmTransfer
): Promise<EvmTransactionSummary> {
  const transaction = prepared.transaction
  const calldataByteLength = (transaction.input.length - 2) / 2
  const callIssues =
    calldataByteLength > 0
      ? transaction.to === null
        ? [Object.freeze({ code: 'unrecognized-call' as const })]
        : evmContractCallReviewIssues(transaction.input, transaction.to)
      : []
  const review = Object.freeze({
    level: callIssues.length > 0 ? ('caution' as const) : ('standard' as const),
    issues: Object.freeze(callIssues)
  })
  return Object.freeze({
    schema: 'evm.transaction.v1' as const,
    chainId: prepared.chainId,
    operation: 'transaction' as const,
    review,
    fields: Object.freeze({
      transactionType: transaction.type,
      from: prepared.from,
      to: transaction.to,
      nonce: transaction.nonce,
      valueWei: transaction.value,
      gasLimit: transaction.gasLimit,
      maximumFeeWei: evmPreparedMaximumFeeWei(prepared),
      l1DataFeeWei: prepared.l1DataFeeWei,
      suggestedFeePerGasWei: prepared.suggestedFeePerGasWei,
      priorityFeeElevated: prepared.priorityFeeElevated,
      gasPriceWei: transaction.type === 'legacy' ? transaction.gasPrice : null,
      maxFeePerGasWei: transaction.type === 'eip1559' ? transaction.maxFeePerGas : null,
      maxPriorityFeePerGasWei:
        transaction.type === 'eip1559' ? transaction.maxPriorityFeePerGas : null,
      accessList: Object.freeze([]),
      calldata: Object.freeze({
        encoding: 'hex' as const,
        value: transaction.input,
        byteLength: calldataByteLength,
        sha256: await computeHexContentSha256(transaction.input)
      }),
      methodSelector: calldataByteLength >= 4 ? transaction.input.slice(0, 10).toLowerCase() : null
    })
  })
}

export async function assertEvmSigningSummaryMatchesPrepared(
  prepared: PreparedEvmTransfer,
  summary: SigningSummary
): Promise<void> {
  if (
    summary.schema !== 'evm.transaction.v1' ||
    summary.chainId !== prepared.chainId ||
    summary.operation !== 'transaction'
  ) {
    throw new Error('EVM signing summary does not match the prepared transaction')
  }
  const transaction = prepared.transaction
  const calldataByteLength = (transaction.input.length - 2) / 2
  const expectedIssues =
    calldataByteLength > 0
      ? transaction.to === null
        ? [Object.freeze({ code: 'unrecognized-call' as const })]
        : evmContractCallReviewIssues(transaction.input, transaction.to)
      : []
  const expectsCallWarning = expectedIssues.length > 0
  const expectedMaximumFee = evmPreparedMaximumFeeWei(prepared)
  const fields = summary.fields
  const addressesMatch = (left: string | null, right: string | null): boolean =>
    left === null || right === null ? left === right : left.toLowerCase() === right.toLowerCase()
  if (
    summary.review.level !== (expectsCallWarning ? 'caution' : 'standard') ||
    summary.review.issues.length !== expectedIssues.length ||
    (expectsCallWarning &&
      (expectedIssues.length !== summary.review.issues.length ||
        expectedIssues.some(
          (expected, index) =>
            summary.review.issues[index]?.code !== expected.code ||
            summary.review.issues[index]?.subjectIndex !== undefined
        ))) ||
    fields.transactionType !== transaction.type ||
    !addressesMatch(fields.from, prepared.from) ||
    !addressesMatch(fields.to, transaction.to) ||
    fields.nonce !== transaction.nonce ||
    fields.valueWei !== transaction.value ||
    fields.gasLimit !== transaction.gasLimit ||
    fields.maximumFeeWei !== expectedMaximumFee ||
    (fields.l1DataFeeWei ?? '0') !== prepared.l1DataFeeWei ||
    (fields.suggestedFeePerGasWei ?? null) !== prepared.suggestedFeePerGasWei ||
    (fields.priorityFeeElevated ?? false) !== prepared.priorityFeeElevated ||
    fields.gasPriceWei !== (transaction.type === 'legacy' ? transaction.gasPrice : null) ||
    fields.maxFeePerGasWei !== (transaction.type === 'eip1559' ? transaction.maxFeePerGas : null) ||
    fields.maxPriorityFeePerGasWei !==
      (transaction.type === 'eip1559' ? transaction.maxPriorityFeePerGas : null) ||
    fields.accessList.length !== 0 ||
    fields.calldata.encoding !== 'hex' ||
    fields.calldata.value !== transaction.input ||
    fields.calldata.byteLength !== calldataByteLength ||
    fields.calldata.sha256 !== (await computeHexContentSha256(transaction.input)) ||
    fields.methodSelector !==
      (calldataByteLength >= 4 ? transaction.input.slice(0, 10).toLowerCase() : null)
  ) {
    throw new Error('EVM signing summary does not match the prepared transaction')
  }
}

function numericChainId(chainId: ChainId): string {
  const match = /^eip155:(0|[1-9][0-9]*)$/.exec(chainId)
  if (match === null || BigInt(match[1]) > MAXIMUM_UINT64) {
    throw new EvmTransactionError('invalid-intent', 'Invalid EVM transaction chain')
  }
  return match[1]
}

function createTransferCall(
  input: BuildEvmTransferInput,
  from: string
): {
  readonly kind: PreparedEvmTransfer['kind']
  readonly assetId: string
  readonly call: EvmRpcCall
  readonly transactionTo: string
  readonly transactionValue: string
  readonly transactionInput: string
} {
  let asset: AssetRegistryEntry
  try {
    const listed = input.assets.get(input.intent.assetId)
    const inspected = listed ?? input.assets.inspect(input.intent.assetId)
    if (
      !inspected ||
      (inspected.verification === 'unverified' &&
        (inspected.asset.kind !== 'token' || inspected.asset.namespace !== 'erc20')) ||
      inspected.verification === 'blocked'
    ) {
      invalidIntent('EVM transfer asset is not listed')
    }
    asset = inspected
  } catch {
    invalidIntent('EVM transfer asset is not listed')
  }
  if (asset.asset.chainId !== input.chainId) invalidIntent('EVM transfer asset is on another chain')
  const recipient = parseRecipient(input.intent.recipient)
  const amount = parseAmount(input.intent.amountRaw, MAXIMUM_UINT256, 'EVM transfer amount')

  if (asset.asset.kind === 'native' && asset.asset.namespace === 'slip44') {
    return Object.freeze({
      kind: 'native-transfer',
      assetId: asset.asset.id,
      call: Object.freeze({ from, to: recipient, valueRaw: amount.toString(), data: '0x' }),
      transactionTo: recipient,
      transactionValue: amount.toString(),
      transactionInput: '0x'
    })
  }
  if (asset.asset.kind === 'token' && asset.asset.namespace === 'erc20') {
    const encodedRecipient = recipient.slice(2).toLowerCase().padStart(64, '0')
    const data = `0x${ERC20_TRANSFER_SELECTOR}${encodedRecipient}${amount
      .toString(16)
      .padStart(64, '0')}`
    return Object.freeze({
      kind: 'erc20-transfer',
      assetId: asset.asset.id,
      call: Object.freeze({ from, to: asset.asset.reference, valueRaw: '0', data }),
      transactionTo: asset.asset.reference,
      transactionValue: '0',
      transactionInput: data
    })
  }
  return invalidIntent('Unsupported EVM transfer asset')
}

export function evmSimulationPreviewExpiresAt(createdAt: number, signingExpiresAt: number): number {
  const previewExpiresAt = createdAt + EVM_SIMULATION_PREVIEW_TTL_MS
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isSafeInteger(signingExpiresAt) ||
    signingExpiresAt < 0 ||
    !Number.isSafeInteger(previewExpiresAt)
  ) {
    throw new Error('EVM simulation preview expiry is invalid')
  }
  return Math.min(signingExpiresAt, previewExpiresAt)
}

function isErc20TransferSimulation(kind: PreparedEvmTransfer['kind'], calldata?: string): boolean {
  if (kind === 'erc20-transfer') return true
  return (
    calldata !== undefined &&
    calldata.length === ERC20_TRANSFER_CALLDATA_LENGTH &&
    calldata.toLowerCase().startsWith(`0x${ERC20_TRANSFER_SELECTOR}`)
  )
}

function assertSimulationResult(
  kind: PreparedEvmTransfer['kind'],
  result: string,
  calldata?: string
): void {
  if (isErc20TransferSimulation(kind, calldata) && result !== '0x' && result !== ERC20_TRUE) {
    throw new EvmTransactionError('simulation-failed', 'ERC-20 transfer simulation failed')
  }
}

async function simulateEvmCall(
  kind: PreparedEvmTransfer['kind'],
  call: EvmRpcCall,
  rpc: Pick<EvmTransactionRpc, 'simulateCall'>,
  signal?: AbortSignal
): Promise<void> {
  let result: string
  try {
    result = await rpc.simulateCall(call, signal)
  } catch (error) {
    if (isInsufficientFundsRpcError(error)) insufficientFunds()
    if (error instanceof EvmRpcError && error.code !== 'rpc-error') throw error
    throw new EvmTransactionError(
      'simulation-failed',
      'EVM transaction simulation failed',
      undefined,
      error instanceof EvmRpcError ? { code: error.rpcCode, method: error.rpcMethod } : undefined
    )
  }
  assertSimulationResult(kind, result, call.data)
}

export function simulatePreparedEvmTransaction(
  prepared: PreparedEvmTransfer,
  rpc: Pick<EvmTransactionRpc, 'simulateCall'>,
  signal?: AbortSignal
): Promise<void> {
  return simulateEvmCall(
    prepared.kind,
    Object.freeze({
      from: prepared.from,
      to: prepared.transaction.to,
      valueRaw: prepared.transaction.value,
      data: prepared.transaction.input
    }),
    rpc,
    signal
  )
}

interface PreparedEvmCall {
  readonly kind: PreparedEvmTransfer['kind']
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
  readonly call: EvmRpcCall
  readonly transactionTo: string
  readonly transactionValue: string
  readonly transactionInput: string
}

function resolveExecutionAccount(
  input: Pick<BuildEvmTransferInput, 'chainId' | 'chainAccount' | 'executionAccount'>
) {
  if (input.executionAccount === undefined) {
    return parseEvmAccountBinding(input.chainAccount, input.chainId)
  }
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(input.executionAccount.address) ||
    !Number.isSafeInteger(input.executionAccount.addressIndex) ||
    input.executionAccount.addressIndex < 0 ||
    input.executionAccount.addressIndex > 0x7fffffff
  ) {
    throw new Error('Invalid PEA execution account')
  }
  return input.executionAccount
}

function createContractCall(input: BuildEvmContractCallInput, from: string): PreparedEvmCall {
  const intent = parseEvmContractCallIntent(input.intent)
  if (intent.chainId !== input.chainId) invalidIntent('EVM contract call is on another chain')
  const nativeAsset = input.assets
    .list(input.chainId)
    .find(entry => entry.asset.kind === 'native' && entry.asset.namespace === 'slip44')
  if (!nativeAsset) invalidIntent('EVM native fee asset is not listed')
  return Object.freeze({
    kind: 'contract-call',
    assetId: nativeAsset.asset.id,
    recipient: intent.contractAddress,
    amountRaw: intent.valueRaw,
    call: Object.freeze({
      from,
      to: intent.contractAddress,
      valueRaw: intent.valueRaw,
      data: intent.calldata
    }),
    transactionTo: intent.contractAddress,
    transactionValue: intent.valueRaw,
    transactionInput: intent.calldata
  })
}

async function estimatePreparedCallFee(
  input: Pick<
    BuildEvmTransferInput,
    'chainId' | 'executionAccount' | 'rpc' | 'feeSelection' | 'feeTier' | 'signal'
  >,
  transactionCall: PreparedEvmCall
) {
  const [nativeBalanceRaw, blockFee] = await Promise.all([
    input.rpc.getNativeBalance(transactionCall.call.from, input.signal),
    input.rpc.getLatestBlockFee(input.signal)
  ])
  const nativeBalance = parseRpcUint256(nativeBalanceRaw, 'EVM native balance')
  const transactionValue = BigInt(transactionCall.transactionValue)
  if (
    nativeBalance < transactionValue ||
    (nativeBalance === 0n && transactionCall.kind !== 'native-transfer')
  ) {
    insufficientFunds(minimumFundingDetails(nativeBalance, transactionValue))
  }
  const simulation = simulateEvmCall(
    transactionCall.kind,
    transactionCall.call,
    input.rpc,
    input.signal
  )
  const gas = input.rpc.estimateGas(transactionCall.call, input.signal).catch(error => {
    if (isInsufficientFundsRpcError(error)) insufficientFunds()
    if (error instanceof EvmRpcError && error.code === 'rpc-error') {
      throw new EvmTransactionError(
        'simulation-failed',
        'EVM gas estimation rejected the call',
        undefined,
        { code: error.rpcCode, method: error.rpcMethod }
      )
    }
    throw error
  })
  const [, gasEstimate] = await Promise.all([simulation, gas])
  const estimatedGas = parseRpcUint64(gasEstimate, 'EVM gas estimate')
  if (estimatedGas === 0n) {
    throw new EvmRpcError('invalid-response', 'EVM gas estimate must be positive')
  }
  const selectedGasLimit =
    input.feeSelection?.kind === 'custom' || input.feeSelection?.kind === 'legacy'
      ? input.feeSelection.gasLimit
      : undefined
  const gasLimit = selectedGasLimit
    ? parseRpcUint64(selectedGasLimit, 'EVM custom gas limit')
    : gasLimitWithMargin(estimatedGas, transactionCall.kind)
  if (gasLimit < estimatedGas) {
    throw new EvmTransactionError('invalid-intent', 'Gas limit is below the estimated gas required')
  }
  const blockNumber = parseRpcUint64(blockFee.blockNumber, 'EVM block number')
  const transactionType: 'legacy' | 'eip1559' =
    blockFee.baseFeePerGas === null ? 'legacy' : 'eip1559'
  let feeQuote: EvmFeeTierQuote
  let suggestedFeePerGasWei: bigint
  if (transactionType === 'legacy') {
    suggestedFeePerGasWei = parseRpcUint64(
      await input.rpc.getGasPrice(input.signal),
      'EVM gas price'
    )
    feeQuote = deriveEvmLegacyFeeQuote({
      ...(input.feeSelection === undefined ? {} : { selection: input.feeSelection }),
      ...(input.feeTier === undefined ? {} : { tier: input.feeTier }),
      suggestedGasPrice: suggestedFeePerGasWei
    })
  } else {
    const baseFeePerGas = parseRpcUint64(blockFee.baseFeePerGas!, 'EVM base fee per gas')
    const [suggestedPriorityRaw, suggestedGasPriceRaw] = await Promise.all([
      input.rpc.getMaximumPriorityFeePerGas(input.signal),
      input.chainId === 'eip155:56'
        ? input.rpc.getGasPrice(input.signal)
        : Promise.resolve(undefined)
    ])
    const minimumPriority = minimumPriorityFeePerGas(
      input.chainId,
      baseFeePerGas,
      suggestedGasPriceRaw
    )
    suggestedFeePerGasWei = parseRpcUint64(suggestedPriorityRaw, 'EVM maximum priority fee per gas')
    feeQuote = deriveEvmFeeTierQuote({
      ...(input.feeSelection === undefined ? {} : { selection: input.feeSelection }),
      ...(input.feeTier === undefined ? {} : { tier: input.feeTier }),
      baseFeePerGas,
      suggestedPriorityFeePerGas: suggestedFeePerGasWei,
      ...(minimumPriority === undefined ? {} : { minimumPriorityFeePerGas: minimumPriority })
    })
  }
  const maximumFee = feeQuote.maxFeePerGas
  if (maximumFee > MAXIMUM_UINT64) {
    throw new EvmTransactionError('fee-overflow', 'EVM maximum fee exceeds signer limits')
  }
  const maximumGasCost = gasLimit * maximumFee
  const requiredNativeBalance = transactionValue + maximumGasCost
  if (nativeBalance < requiredNativeBalance) {
    const shortfall = requiredNativeBalance - nativeBalance
    throw new EvmTransactionError(
      'insufficient-funds',
      `${input.executionAccount ? 'Private Execution Address' : 'EVM account'} needs ${shortfall} more wei for transaction value and maximum Gas`,
      Object.freeze({
        requiredNativeBalanceRaw: requiredNativeBalance.toString(),
        availableNativeBalanceRaw: nativeBalance.toString(),
        shortfallRaw: shortfall.toString(),
        maximumGasCostRaw: maximumGasCost.toString(),
        transactionValueRaw: transactionCall.transactionValue
      })
    )
  }
  return {
    gasLimit,
    feeQuote,
    blockNumber,
    transactionType,
    suggestedFeePerGasWei,
    nativeBalance,
    transactionValue
  }
}

function mapOpStackFeeError(error: unknown): never {
  if (error instanceof OpStackFeeError) {
    throw new EvmTransactionError(
      error.code === 'overflow' ? 'fee-overflow' : 'invalid-intent',
      error.message
    )
  }
  throw error
}

async function annotatePreparedNetworkFee(input: {
  readonly chainId: ChainId
  readonly rpc: EvmTransactionRpc
  readonly signal?: AbortSignal
  readonly executionAccount?: PeaEvmExecutionAccount
  readonly nativeBalance: bigint
  readonly transaction: EvmPreparedTransaction
  readonly suggestedFeePerGasWei: bigint
}): Promise<
  Pick<PreparedEvmTransfer, 'l1DataFeeWei' | 'suggestedFeePerGasWei' | 'priorityFeeElevated'>
> {
  let l1DataFeeWei: bigint
  try {
    l1DataFeeWei = await quoteOpStackL1DataFee({
      chainId: input.chainId,
      transaction: input.transaction,
      rpc: input.rpc,
      signal: input.signal
    })
  } catch (error) {
    mapOpStackFeeError(error)
  }
  const transactionValue = BigInt(input.transaction.value)
  const executionFee =
    BigInt(input.transaction.gasLimit) *
    BigInt(
      input.transaction.type === 'legacy'
        ? input.transaction.gasPrice
        : input.transaction.maxFeePerGas
    )
  const maximumNetworkFee = executionFee + l1DataFeeWei
  const requiredNativeBalance = transactionValue + maximumNetworkFee
  if (input.nativeBalance < requiredNativeBalance) {
    const shortfall = requiredNativeBalance - input.nativeBalance
    throw new EvmTransactionError(
      'insufficient-funds',
      `${input.executionAccount ? 'Private Execution Address' : 'EVM account'} needs ${shortfall} more wei for transaction value and maximum Gas`,
      Object.freeze({
        requiredNativeBalanceRaw: requiredNativeBalance.toString(),
        availableNativeBalanceRaw: input.nativeBalance.toString(),
        shortfallRaw: shortfall.toString(),
        maximumGasCostRaw: maximumNetworkFee.toString(),
        transactionValueRaw: input.transaction.value
      })
    )
  }
  const chosenFeePerGasWei = BigInt(
    input.transaction.type === 'legacy'
      ? input.transaction.gasPrice
      : input.transaction.maxPriorityFeePerGas
  )
  return Object.freeze({
    l1DataFeeWei: l1DataFeeWei.toString(),
    suggestedFeePerGasWei: input.suggestedFeePerGasWei.toString(),
    priorityFeeElevated: isPriorityFeeElevated(chosenFeePerGasWei, input.suggestedFeePerGasWei)
  })
}

async function estimateEvmCall(
  input: BuildEvmTransferInput | BuildEvmContractCallInput,
  preparedCall: (from: string) => PreparedEvmCall
): Promise<EvmFeeEstimate> {
  const account = resolveExecutionAccount(input)
  const call = preparedCall(account.address)
  await input.rpc.assertExpectedChain(input.signal)
  // Fee estimation always simulates the call. Only a confirmed empty recipient
  // may mark a 21,000-gas native fee as amount-independent. Bytecode and an
  // EIP-7702 delegation designator (0xef0100...) stay on that simulated path.
  // A missing or failed code lookup fails closed the same way.
  const recipientHasNoRuntimeCode =
    call.kind === 'native-transfer' && input.rpc.getCode
      ? input.rpc.getCode(call.transactionTo, input.signal).then(
          code => !evmBytecodeHasRuntimeCode(code),
          () => false
        )
      : Promise.resolve(false)
  const [fee, confirmedEmptyRecipient] = await Promise.all([
    estimatePreparedCallFee(input, call),
    recipientHasNoRuntimeCode
  ])
  const { gasLimit, feeQuote, transactionType, suggestedFeePerGasWei, nativeBalance } = fee
  const chosenFeePerGasWei =
    transactionType === 'legacy' ? feeQuote.maxFeePerGas : feeQuote.maxPriorityFeePerGas
  let l1DataFeeWei = 0n
  let priorityFeeElevated = isPriorityFeeElevated(chosenFeePerGasWei, suggestedFeePerGasWei)
  if (isOpStackExecutionFee(input.chainId)) {
    const pendingNonce = parseRpcUint64(
      await input.rpc.getPendingNonce(account.address, input.signal),
      'EVM pending nonce'
    )
    const nonceFloor =
      input.nonceFloor === undefined
        ? pendingNonce
        : parseRpcUint64(input.nonceFloor, 'EVM local nonce floor')
    const annotation = await annotatePreparedNetworkFee({
      chainId: input.chainId,
      rpc: input.rpc,
      signal: input.signal,
      ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
      nativeBalance,
      suggestedFeePerGasWei,
      transaction: provisionalTransaction({
        chainId: input.chainId,
        transactionType,
        nonce: (pendingNonce > nonceFloor ? pendingNonce : nonceFloor).toString(),
        gasLimit,
        feeQuote,
        to: call.transactionTo,
        value: call.transactionValue,
        input: call.transactionInput
      })
    })
    l1DataFeeWei = BigInt(annotation.l1DataFeeWei)
    priorityFeeElevated = annotation.priorityFeeElevated
  }
  return Object.freeze({
    chainId: input.chainId,
    transactionType,
    maximumFeeWei: (gasLimit * feeQuote.maxFeePerGas + l1DataFeeWei).toString(),
    maxFeePerGasWei: feeQuote.maxFeePerGas.toString(),
    maxPriorityFeePerGasWei: feeQuote.maxPriorityFeePerGas.toString(),
    gasPriceWei: transactionType === 'legacy' ? feeQuote.maxFeePerGas.toString() : null,
    gasLimit: gasLimit.toString(),
    ...(l1DataFeeWei === 0n ? {} : { l1DataFeeWei: l1DataFeeWei.toString() }),
    ...(priorityFeeElevated ? { priorityFeeElevated: true } : {}),
    ...(call.kind === 'native-transfer' &&
    gasLimit === EVM_SIMPLE_TRANSFER_GAS &&
    confirmedEmptyRecipient
      ? { amountIndependent: true }
      : {})
  })
}

export function estimateEvmTransferFee(input: BuildEvmTransferInput): Promise<EvmFeeEstimate> {
  return estimateEvmCall(input, from => ({
    ...createTransferCall(input, from),
    recipient: input.intent.recipient,
    amountRaw: input.intent.amountRaw
  }))
}

export function estimateEvmContractCallFee(
  input: BuildEvmContractCallInput
): Promise<EvmFeeEstimate> {
  return estimateEvmCall(input, from => createContractCall(input, from))
}

async function buildPreparedEvmTransaction(
  input: Pick<
    BuildEvmTransferInput,
    | 'chainId'
    | 'chainAccount'
    | 'executionAccount'
    | 'rpc'
    | 'feeSelection'
    | 'feeTier'
    | 'nonceFloor'
    | 'signal'
    | 'now'
  >,
  preparedCall: (from: string) => PreparedEvmCall
): Promise<PreparedEvmTransfer> {
  const account = resolveExecutionAccount(input)
  const transactionCall = preparedCall(account.address)
  await input.rpc.assertExpectedChain(input.signal)

  const [pendingNonceRaw, fee] = await Promise.all([
    input.rpc.getPendingNonce(account.address, input.signal),
    estimatePreparedCallFee(input, transactionCall)
  ])
  const rpcNonce = parseRpcUint64(pendingNonceRaw, 'EVM pending nonce')
  const nonceFloor =
    input.nonceFloor === undefined
      ? rpcNonce
      : parseRpcUint64(input.nonceFloor, 'EVM local nonce floor')
  const nonce = rpcNonce > nonceFloor ? rpcNonce : nonceFloor
  const { gasLimit, feeQuote, blockNumber, transactionType, suggestedFeePerGasWei, nativeBalance } =
    fee
  const transaction = provisionalTransaction({
    chainId: input.chainId,
    transactionType,
    nonce: nonce.toString(),
    gasLimit,
    feeQuote,
    to: transactionCall.transactionTo,
    value: transactionCall.transactionValue,
    input: transactionCall.transactionInput
  })
  const annotation = await annotatePreparedNetworkFee({
    chainId: input.chainId,
    rpc: input.rpc,
    signal: input.signal,
    ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
    nativeBalance,
    suggestedFeePerGasWei,
    transaction
  })

  return Object.freeze({
    kind: transactionCall.kind,
    chainId: input.chainId,
    addressIndex: account.addressIndex,
    from: account.address,
    assetId: transactionCall.assetId,
    recipient: transactionCall.recipient,
    amountRaw: transactionCall.amountRaw,
    observedBlockNumber: blockNumber.toString(),
    transaction,
    ...annotation,
    createdAt: parseTimestamp((input.now ?? Date.now)())
  })
}

function provisionalTransaction(input: {
  readonly chainId: ChainId
  readonly transactionType: 'legacy' | 'eip1559'
  readonly nonce: string
  readonly gasLimit: bigint
  readonly feeQuote: EvmFeeTierQuote
  readonly to: string
  readonly value: string
  readonly input: string
}): EvmPreparedTransaction {
  return Object.freeze({
    ...(input.transactionType === 'legacy'
      ? { type: 'legacy' as const, gasPrice: input.feeQuote.maxFeePerGas.toString() }
      : {
          type: 'eip1559' as const,
          maxFeePerGas: input.feeQuote.maxFeePerGas.toString(),
          maxPriorityFeePerGas: input.feeQuote.maxPriorityFeePerGas.toString(),
          accessList: Object.freeze([])
        }),
    chainId: numericChainId(input.chainId),
    nonce: input.nonce,
    gasLimit: input.gasLimit.toString(),
    to: input.to,
    value: input.value,
    input: input.input
  })
}

export function buildEvmTransfer(input: BuildEvmTransferInput): Promise<PreparedEvmTransfer> {
  return buildPreparedEvmTransaction(input, from => {
    const transfer = createTransferCall(input, from)
    return Object.freeze({
      ...transfer,
      recipient: input.intent.recipient,
      amountRaw: input.intent.amountRaw
    })
  })
}

export function buildEvmContractCall(
  input: BuildEvmContractCallInput
): Promise<PreparedEvmTransfer> {
  return buildPreparedEvmTransaction(input, from => createContractCall(input, from))
}

function replacementMinimum(value: bigint): bigint {
  const increased = (value * 1125n + 999n) / 1000n
  return increased > value ? increased : value + 1n
}

export async function buildEvmCancelTransaction(
  input: BuildEvmCancelInput
): Promise<PreparedEvmTransfer> {
  const account =
    input.executionAccount === undefined
      ? parseEvmAccountBinding(input.chainAccount, input.chainId)
      : input.executionAccount
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.original.transactionHash)) {
    throw new EvmTransactionError('invalid-intent', 'Invalid original EVM transaction hash')
  }
  const nonce = parseRpcUint64(input.original.nonce, 'original EVM nonce')
  const originalMaxFee = parseRpcUint64(input.original.maxFeePerGasWei, 'original EVM maximum fee')
  const originalPriorityFee = parseRpcUint64(
    input.original.maxPriorityFeePerGasWei,
    'original EVM priority fee'
  )
  await input.rpc.assertExpectedChain(input.signal)
  await assertEvmOriginalReplaceable(
    input.rpc,
    account.address,
    input.original.transactionHash,
    nonce,
    input.allowUnknownAtNonce === true,
    input.signal
  )
  return buildEvmSelfTransaction(input, account, nonce, 'cancel', {
    maxFeePerGas: originalMaxFee,
    maxPriorityFeePerGas: originalPriorityFee
  })
}

async function assertEvmOriginalReplaceable(
  rpc: BuildEvmCancelInput['rpc'],
  address: string,
  transactionHash: string,
  nonce: bigint,
  allowUnknownAtNonce: boolean,
  signal?: AbortSignal
): Promise<void> {
  const location = await rpc.getTransactionLocation(transactionHash, signal)
  if (location.status !== 'pending' && !(location.status === 'unknown' && allowUnknownAtNonce)) {
    throw new EvmTransactionError(
      'stale-nonce',
      'The original EVM transaction is no longer pending'
    )
  }
  await assertEvmReplacementNonceAvailable(rpc, address, nonce, signal)
  if (
    location.status === 'unknown' &&
    parseRpcUint64(await rpc.getPendingNonce(address, signal), 'EVM pending nonce') !== nonce
  ) {
    throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
  }
}

export async function buildEvmSpeedUpTransaction(
  input: BuildEvmSpeedUpInput
): Promise<PreparedEvmTransfer> {
  const account =
    input.executionAccount === undefined
      ? parseEvmAccountBinding(input.chainAccount, input.chainId)
      : input.executionAccount
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.original.transactionHash)) {
    throw new EvmTransactionError('invalid-intent', 'Invalid original EVM transaction hash')
  }
  const original = parsePersistedTransaction(input.original.transaction, input.chainId)
  const nonce = BigInt(original.nonce)
  await input.rpc.assertExpectedChain(input.signal)
  await assertEvmOriginalReplaceable(
    input.rpc,
    account.address,
    input.original.transactionHash,
    nonce,
    input.allowUnknownAtNonce === true,
    input.signal
  )
  const [nativeBalanceRaw, blockFee] = await Promise.all([
    input.rpc.getNativeBalance(account.address, input.signal),
    input.rpc.getLatestBlockFee(input.signal)
  ])
  const observedBlockNumber = parseRpcUint64(blockFee.blockNumber, 'EVM block number').toString()
  let transaction: EvmPreparedTransaction
  let suggestedFeePerGasWei: bigint
  if (original.type === 'legacy') {
    suggestedFeePerGasWei = parseRpcUint64(
      await input.rpc.getGasPrice(input.signal),
      'EVM gas price'
    )
    const quote = deriveEvmLegacyFeeQuote({
      selection: input.feeSelection ?? { kind: 'tier', tier: 'fast' },
      suggestedGasPrice: suggestedFeePerGasWei
    })
    const minimum = replacementMinimum(BigInt(original.gasPrice))
    const gasPrice = quote.maxFeePerGas > minimum ? quote.maxFeePerGas : minimum
    transaction = Object.freeze({ ...original, gasPrice: gasPrice.toString() })
  } else {
    if (blockFee.baseFeePerGas === null) {
      throw new EvmTransactionError('invalid-intent', 'EVM fee market changed')
    }
    const baseFee = parseRpcUint64(blockFee.baseFeePerGas, 'EVM base fee per gas')
    const [suggestedPriorityRaw, suggestedGasPriceRaw] = await Promise.all([
      input.rpc.getMaximumPriorityFeePerGas(input.signal),
      input.chainId === 'eip155:56'
        ? input.rpc.getGasPrice(input.signal)
        : Promise.resolve(undefined)
    ])
    const networkMinimumPriority = minimumPriorityFeePerGas(
      input.chainId,
      baseFee,
      suggestedGasPriceRaw
    )
    suggestedFeePerGasWei = parseRpcUint64(suggestedPriorityRaw, 'EVM maximum priority fee per gas')
    const quote = deriveEvmFeeTierQuote({
      selection: input.feeSelection ?? { kind: 'tier', tier: 'fast' },
      baseFeePerGas: baseFee,
      suggestedPriorityFeePerGas: suggestedFeePerGasWei,
      ...(networkMinimumPriority === undefined
        ? {}
        : { minimumPriorityFeePerGas: networkMinimumPriority })
    })
    const priorityMinimum = replacementMinimum(BigInt(original.maxPriorityFeePerGas))
    const maxPriorityFeePerGas =
      quote.maxPriorityFeePerGas > priorityMinimum ? quote.maxPriorityFeePerGas : priorityMinimum
    const maxFeeMinimum = replacementMinimum(BigInt(original.maxFeePerGas))
    const marketMaxFee = baseFee * 2n + maxPriorityFeePerGas
    const maxFeePerGas = [quote.maxFeePerGas, maxFeeMinimum, marketMaxFee].reduce((a, b) =>
      a > b ? a : b
    )
    transaction = Object.freeze({
      ...original,
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString()
    })
  }
  const maximumFeePerGas = BigInt(
    transaction.type === 'legacy' ? transaction.gasPrice : transaction.maxFeePerGas
  )
  if (
    maximumFeePerGas > MAXIMUM_UINT64 ||
    (transaction.type === 'eip1559' && BigInt(transaction.maxPriorityFeePerGas) > MAXIMUM_UINT64)
  ) {
    throw new EvmTransactionError('fee-overflow', 'EVM speed up fee exceeds signer limits')
  }
  const nativeBalance = parseRpcUint256(nativeBalanceRaw, 'EVM native balance')
  const maximumGasCost = BigInt(transaction.gasLimit) * maximumFeePerGas
  const requiredNativeBalance = BigInt(transaction.value) + maximumGasCost
  if (nativeBalance < requiredNativeBalance) {
    insufficientFunds({
      requiredNativeBalanceRaw: requiredNativeBalance.toString(),
      availableNativeBalanceRaw: nativeBalance.toString(),
      shortfallRaw: (requiredNativeBalance - nativeBalance).toString(),
      maximumGasCostRaw: maximumGasCost.toString(),
      transactionValueRaw: transaction.value
    })
  }
  const nativeAsset = input.assets
    .list(input.chainId)
    .find(entry => entry.asset.kind === 'native' && entry.asset.namespace === 'slip44')
  if (!nativeAsset) invalidIntent('EVM native fee asset is not listed')
  const annotation = await annotatePreparedNetworkFee({
    chainId: input.chainId,
    rpc: input.rpc,
    signal: input.signal,
    ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
    nativeBalance,
    suggestedFeePerGasWei,
    transaction
  })
  const prepared = Object.freeze({
    kind: 'speed-up' as const,
    chainId: input.chainId,
    addressIndex: account.addressIndex,
    from: account.address,
    assetId: nativeAsset.asset.id,
    recipient: transaction.to,
    amountRaw: transaction.value,
    observedBlockNumber,
    transaction,
    ...annotation,
    createdAt: parseTimestamp((input.now ?? Date.now)())
  })
  await simulatePreparedEvmTransaction(prepared, input.rpc, input.signal)
  return prepared
}

export async function assertEvmReplacementNonceAvailable(
  rpc: Pick<EvmDAppReadRpc, 'getTransactionCount'>,
  address: string,
  nonce: bigint,
  signal?: AbortSignal
): Promise<void> {
  const confirmedNonce = parseRpcUint64(
    await rpc.getTransactionCount(address, 'latest', signal),
    'EVM confirmed nonce'
  )
  if (confirmedNonce > nonce) {
    throw new EvmTransactionError('stale-nonce', 'EVM nonce was confirmed by another transaction')
  }
}

export async function buildEvmNonceRecoveryTransaction(
  input: BuildEvmNonceRecoveryInput
): Promise<PreparedEvmTransfer> {
  const account =
    input.executionAccount === undefined
      ? parseEvmAccountBinding(input.chainAccount, input.chainId)
      : input.executionAccount
  const nonce = parseRpcUint64(input.nonce, 'EVM recovery nonce')
  await input.rpc.assertExpectedChain(input.signal)
  const pendingNonce = parseRpcUint64(
    await input.rpc.getPendingNonce(account.address, input.signal),
    'EVM pending nonce'
  )
  if (pendingNonce > nonce) {
    throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
  }
  return buildEvmSelfTransaction(input, account, nonce, 'nonce-recovery')
}

async function buildEvmSelfTransaction(
  input: BuildEvmNonceRecoveryInput | BuildEvmCancelInput,
  account: Pick<PeaEvmExecutionAccount, 'address' | 'addressIndex'>,
  nonce: bigint,
  kind: 'cancel' | 'nonce-recovery',
  originalFee?: Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
): Promise<PreparedEvmTransfer> {
  const call = Object.freeze({
    from: account.address,
    to: account.address,
    valueRaw: '0',
    data: '0x'
  })
  const [nativeBalanceRaw, gasEstimate, suggestedPriorityRaw, blockFee, suggestedGasPriceRaw] =
    await Promise.all([
      input.rpc.getNativeBalance(account.address, input.signal),
      input.rpc.estimateGas(call, input.signal),
      input.rpc.getMaximumPriorityFeePerGas(input.signal),
      input.rpc.getLatestBlockFee(input.signal),
      input.chainId === 'eip155:56'
        ? input.rpc.getGasPrice(input.signal)
        : Promise.resolve(undefined)
    ])
  const nativeBalance = parseRpcUint256(nativeBalanceRaw, 'EVM native balance')
  const gasLimit = parseRpcUint64(gasEstimate, 'EVM cancel gas estimate')
  if (gasLimit === 0n) {
    throw new EvmRpcError('invalid-response', 'EVM gas estimate must be positive')
  }
  const suggestedPriority = parseRpcUint64(suggestedPriorityRaw, 'EVM maximum priority fee per gas')
  if (blockFee.baseFeePerGas === null) {
    throw new EvmTransactionError('invalid-intent', 'Legacy transaction replacement is unavailable')
  }
  const baseFee = parseRpcUint64(blockFee.baseFeePerGas, 'EVM base fee per gas')
  const blockNumber = parseRpcUint64(blockFee.blockNumber, 'EVM block number')
  const networkMinimumPriority = minimumPriorityFeePerGas(
    input.chainId,
    baseFee,
    suggestedGasPriceRaw
  )
  const quote = deriveEvmFeeTierQuote({
    selection: input.feeSelection ?? { kind: 'tier', tier: 'fast' },
    baseFeePerGas: baseFee,
    suggestedPriorityFeePerGas: suggestedPriority,
    ...(networkMinimumPriority === undefined
      ? {}
      : { minimumPriorityFeePerGas: networkMinimumPriority })
  })
  const minimumPriority = originalFee ? replacementMinimum(originalFee.maxPriorityFeePerGas) : 0n
  const maxPriorityFeePerGas =
    quote.maxPriorityFeePerGas > minimumPriority ? quote.maxPriorityFeePerGas : minimumPriority
  const marketMaxFee = baseFee * 2n + maxPriorityFeePerGas
  const minimumMaxFee = originalFee ? replacementMinimum(originalFee.maxFeePerGas) : 0n
  const maxFeePerGas = [quote.maxFeePerGas, marketMaxFee, minimumMaxFee].reduce((a, b) =>
    a > b ? a : b
  )
  if (maxFeePerGas > MAXIMUM_UINT64 || maxPriorityFeePerGas > maxFeePerGas) {
    throw new EvmTransactionError('fee-overflow', 'EVM cancel fee exceeds signer limits')
  }
  const maximumGasCost = gasLimit * maxFeePerGas
  if (nativeBalance < maximumGasCost) {
    insufficientFunds({
      requiredNativeBalanceRaw: maximumGasCost.toString(),
      availableNativeBalanceRaw: nativeBalance.toString(),
      shortfallRaw: (maximumGasCost - nativeBalance).toString(),
      maximumGasCostRaw: maximumGasCost.toString(),
      transactionValueRaw: '0'
    })
  }
  const nativeAsset = input.assets
    .list(input.chainId)
    .find(entry => entry.asset.kind === 'native' && entry.asset.namespace === 'slip44')
  if (!nativeAsset) invalidIntent('EVM native fee asset is not listed')
  const transaction = Object.freeze({
    type: 'eip1559' as const,
    chainId: numericChainId(input.chainId),
    nonce: nonce.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    gasLimit: gasLimit.toString(),
    to: account.address,
    value: '0',
    input: '0x',
    accessList: Object.freeze([])
  })
  const annotation = await annotatePreparedNetworkFee({
    chainId: input.chainId,
    rpc: input.rpc,
    signal: input.signal,
    ...(input.executionAccount === undefined ? {} : { executionAccount: input.executionAccount }),
    nativeBalance,
    suggestedFeePerGasWei: suggestedPriority,
    transaction
  })
  const prepared = Object.freeze({
    kind,
    chainId: input.chainId,
    addressIndex: account.addressIndex,
    from: account.address,
    assetId: nativeAsset.asset.id,
    recipient: account.address,
    amountRaw: '0',
    observedBlockNumber: blockNumber.toString(),
    transaction,
    ...annotation,
    createdAt: parseTimestamp((input.now ?? Date.now)())
  })
  await simulatePreparedEvmTransaction(prepared, input.rpc, input.signal)
  return prepared
}

export async function assertEvmTransferFresh(
  prepared: PreparedEvmTransfer,
  rpc: EvmTransactionRpc,
  signal?: AbortSignal
): Promise<void> {
  await rpc.assertExpectedChain(signal)
  const currentNonce = parseRpcUint64(
    await rpc.getPendingNonce(prepared.from, signal),
    'EVM pending nonce'
  )
  if (currentNonce > BigInt(prepared.transaction.nonce)) {
    throw new EvmTransactionError('stale-nonce', 'EVM pending nonce changed')
  }
}

export function createEvmSigningPreparePayload(
  prepared: PreparedEvmTransfer,
  executionMode: 'main' | 'private' = 'main'
): EvmSigningPreparePayload {
  return Object.freeze({
    kind: executionMode === 'private' ? 'pea-evm-transaction' : 'evm-transaction',
    chainId: prepared.chainId,
    addressIndex: prepared.addressIndex,
    transaction: prepared.transaction,
    l1DataFeeWei: prepared.l1DataFeeWei,
    suggestedFeePerGasWei: prepared.suggestedFeePerGasWei,
    priorityFeeElevated: prepared.priorityFeeElevated
  })
}
