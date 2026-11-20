import type {
  BitcoinBip322MessageSummary,
  BitcoinPsbtSummary,
  EvmPersonalMessageSummary,
  EvmTransactionSummary,
  EvmTypedDataSummary,
  EvmTypedDataValue,
  NearActionSummary,
  NearNep413MessageSummary,
  NearTransactionSummary,
  SolanaMessageSummary,
  SolanaTransactionSummary,
  ZcashMessageSummary,
  ZcashTransactionSummary
} from '@/core/keyring/domain'
import { nearFunctionCallReviewRows } from './near-function-call-review'
import {
  canonicalContentRows,
  completeReviewModel,
  payloadDigestRows,
  reviewRow,
  UNLIMITED_AMOUNT_LABEL,
  type SigningSummaryReviewModel,
  type SigningSummaryReviewRow,
  type TokenAuthorizationReview
} from './signing-summary-review-model-types'
import {
  decodeEvmTypedDataRecognition,
  type EvmBlurOrder,
  type EvmReceiverOrder,
  type EvmSafeTx,
  type EvmSeaportOrder,
  type EvmTypedDataRecognition
} from '@/infrastructure/chains/evm/evm-typed-data-recognition'
import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import {
  decodeErc20CalldataRequest,
  decodeEvmAuthorizationCall,
  PERMIT2_CONTRACT,
  PERMIT2_LOCKDOWN_EFFECT,
  PERMIT2_TOKEN_REVOKE_EFFECT
} from '@/infrastructure/chains/evm/evm-contract-call-classification'
import { formatSortAddress } from '@/lib/format'
import {
  formatAmount,
  formatBaseUnitDecimalAmount,
  formatFeeAmount,
  formatReviewAmount
} from '@/lib/number-format'
import {
  evmRpcOriginLabel,
  presentEvmRevocationLabel,
  type EvmRpcOrigin
} from '@/core/chains/evm-rpc-origin'
import {
  aggregateEvmSimulationAssetChanges,
  type EvmSimulationTransfers
} from '@/core/chains/evm/evm-simulation-asset-changes'

export interface EvmReviewPresentationOptions {
  readonly nativeCurrency?: { readonly symbol: string; readonly decimals: number }
  readonly directContract?: boolean
  readonly rpcOrigin?: EvmRpcOrigin
  readonly tokenMetadata?: readonly {
    readonly contractAddress: string
    readonly symbol: string
    readonly name?: string
    readonly decimals: number
    readonly verification?: 'trusted' | 'user-approved' | 'unverified'
  }[]
  readonly simulationTransfers?: EvmSimulationTransfers
}

const MAX_UINT256 = ((1n << 256n) - 1n).toString()

type UnlimitedAmountUnit = keyof typeof UNLIMITED_AMOUNT_LABEL

function unlimitedAllowanceUnit(
  amountRaw: string,
  amountBits: 160 | 256
): UnlimitedAmountUnit | undefined {
  // Unlimited is exact equality with the field maximum, not a large-value cutoff.
  if (BigInt(amountRaw) !== (1n << BigInt(amountBits)) - 1n) return undefined
  return amountBits === 160 ? 'uint160' : 'uint256'
}

const DISPLAY_CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/
const MAXIMUM_REPORTED_SYMBOL_CODE_POINTS = 32
const MAXIMUM_REPORTED_NAME_CODE_POINTS = 128
const TOKEN_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

function readDisplayText(value: string, maximumCodePoints: number): string | undefined {
  const text = value.normalize('NFC')
  if (
    text.length === 0 ||
    text.trim() !== text ||
    [...text].length > maximumCodePoints ||
    DISPLAY_CONTROL_CHARACTERS.test(text)
  ) {
    return undefined
  }
  return text
}

function sameContractAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function decimalsInRange(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255
}

function reviewToken(options: EvmReviewPresentationOptions, contractAddress: string) {
  return options.tokenMetadata?.find(token =>
    sameContractAddress(token.contractAddress, contractAddress)
  )
}

function bundledToken(
  options: EvmReviewPresentationOptions,
  contractAddress: string
): { readonly symbol: string; readonly name?: string; readonly decimals: number } | undefined {
  const token = reviewToken(options, contractAddress)
  if (!token || token.verification !== 'trusted' || !decimalsInRange(token.decimals)) {
    return undefined
  }
  const symbol = readDisplayText(token.symbol, MAXIMUM_REPORTED_SYMBOL_CODE_POINTS)
  if (!symbol) return undefined
  const name =
    token.name === undefined
      ? undefined
      : readDisplayText(token.name, MAXIMUM_REPORTED_NAME_CODE_POINTS)
  return { symbol, decimals: token.decimals, ...(name === undefined ? {} : { name }) }
}

function userApprovedToken(
  options: EvmReviewPresentationOptions,
  contractAddress: string
): { readonly symbol: string; readonly decimals: number } | undefined {
  const token = reviewToken(options, contractAddress)
  if (!token || token.verification !== 'user-approved' || !decimalsInRange(token.decimals)) {
    return undefined
  }
  const symbol = readDisplayText(token.symbol, MAXIMUM_REPORTED_SYMBOL_CODE_POINTS)
  if (!symbol) return undefined
  return { symbol, decimals: token.decimals }
}

function reportedMetadataSymbol(
  options: EvmReviewPresentationOptions,
  contractAddress: string
): string | undefined {
  const token = reviewToken(options, contractAddress)
  if (!token || token.verification === 'trusted' || token.verification === 'user-approved') {
    return undefined
  }
  return readDisplayText(token.symbol, MAXIMUM_REPORTED_SYMBOL_CODE_POINTS)
}

function presentTokenIdentity(
  options: EvmReviewPresentationOptions,
  contractAddress: string,
  amountRaw: string,
  domainName?: string
): { readonly symbol: string | null; readonly amount: string; readonly selfReportedName?: string } {
  const bundled = bundledToken(options, contractAddress)
  if (bundled) {
    const conflicts =
      domainName !== undefined && domainName !== bundled.symbol && domainName !== bundled.name
    return {
      symbol: bundled.symbol,
      amount: formatBaseUnitDecimalAmount(amountRaw, bundled.decimals),
      ...(conflicts ? { selfReportedName: domainName } : {})
    }
  }
  const approved = userApprovedToken(options, contractAddress)
  const selfReportedName =
    domainName ?? approved?.symbol ?? reportedMetadataSymbol(options, contractAddress)
  return {
    symbol: null,
    amount: approved ? formatBaseUnitDecimalAmount(amountRaw, approved.decimals) : amountRaw,
    ...(selfReportedName === undefined ? {} : { selfReportedName })
  }
}

function evmAuthorizationCallRows(
  summary: EvmTransactionSummary,
  options: EvmReviewPresentationOptions
): readonly SigningSummaryReviewRow[] {
  const contract = summary.fields.to
  if (contract === null || summary.fields.calldata.encoding !== 'hex') return []
  const authorization = decodeEvmAuthorizationCall(summary.fields.calldata.value, contract)
  if (!authorization) return []
  const addressRow = (label: string, value: string) =>
    reviewRow(label, formatSortAddress(value), { code: true, title: value })
  const formatTokenAmount = (contractAddress: string, raw: string, unlimited: boolean) => {
    if (unlimited) return 'Unlimited'
    const knownToken = bundledToken(options, contractAddress)
    return knownToken ? `${formatAmount(raw, knownToken.decimals)} ${knownToken.symbol}` : raw
  }
  const allowanceRow = (
    contractAddress: string,
    raw: string,
    unlimitedUnit: UnlimitedAmountUnit | undefined
  ) =>
    reviewRow(
      'Requested allowance',
      formatTokenAmount(contractAddress, raw, unlimitedUnit !== undefined),
      {
        code: true,
        breakAll: true,
        ...(unlimitedUnit === undefined
          ? {}
          : { tone: 'warning' as const, title: UNLIMITED_AMOUNT_LABEL[unlimitedUnit] })
      }
    )
  const permit2RevokeRow = clearsPermit2TokenAllowance(authorization)
    ? [reviewRow('Revoke effect', PERMIT2_TOKEN_REVOKE_EFFECT)]
    : []
  switch (authorization.kind) {
    case 'erc20-approve':
      return [
        reviewRow('Requested method', 'approve', { code: true }),
        addressRow('Requested spender', authorization.spender),
        allowanceRow(
          contract,
          authorization.amountRaw,
          authorization.unlimited ? 'uint256' : undefined
        ),
        ...permit2RevokeRow
      ]
    case 'erc20-increase-allowance':
      return [
        reviewRow('Requested method', 'increaseAllowance', { code: true }),
        addressRow('Requested spender', authorization.spender),
        reviewRow(
          'Allowance increase',
          formatTokenAmount(contract, authorization.amountRaw, false),
          { code: true, breakAll: true }
        )
      ]
    case 'erc20-decrease-allowance':
      return [
        reviewRow('Requested method', 'decreaseAllowance', { code: true }),
        addressRow('Requested spender', authorization.spender),
        reviewRow(
          'Allowance decrease',
          formatTokenAmount(contract, authorization.amountRaw, false),
          { code: true, breakAll: true }
        ),
        ...permit2RevokeRow
      ]
    case 'erc721-set-approval-for-all':
      return [
        reviewRow('Requested method', 'setApprovalForAll', { code: true }),
        addressRow('Requested operator', authorization.operator),
        reviewRow('Approve all tokens', authorization.approved ? 'Yes' : 'No', {
          ...(authorization.approved ? { tone: 'warning' as const } : {})
        })
      ]
    case 'permit2-approve':
      return [
        reviewRow('Requested method', 'Permit2.approve', { code: true }),
        addressRow('Token contract', authorization.token),
        addressRow('Requested spender', authorization.spender),
        allowanceRow(
          authorization.token,
          authorization.amountRaw,
          authorization.unlimited ? 'uint160' : undefined
        ),
        reviewRow(
          'Expiration',
          authorization.expirationRaw === '0' ? 'On submission' : authorization.expirationRaw,
          {
            code: authorization.expirationRaw !== '0'
          }
        )
      ]
    case 'permit2-lockdown':
      return [
        reviewRow('Requested method', 'Permit2.lockdown', { code: true }),
        ...authorization.pairs.flatMap((pair, index) => {
          const suffix = authorization.pairs.length > 1 ? ` ${index + 1}` : ''
          return [
            addressRow(`Token contract${suffix}`, pair.token),
            addressRow(`Spender${suffix}`, pair.spender),
            reviewRow(`Effect${suffix}`, 'Amount and expiration set to zero')
          ]
        })
      ]
    default:
      return assertNever(authorization)
  }
}

function evmRequestedTokenCallRows(
  summary: EvmTransactionSummary,
  options: EvmReviewPresentationOptions
): readonly SigningSummaryReviewRow[] {
  const contract = summary.fields.to
  if (contract === null || summary.fields.calldata.encoding !== 'hex') return []
  const authorizationRows = evmAuthorizationCallRows(summary, options)
  if (authorizationRows.length > 0) return authorizationRows
  const request = decodeErc20CalldataRequest(summary.fields.calldata.value)
  if (!request) return []
  const knownToken = bundledToken(options, contract)
  // ERC-721 shares approve/transferFrom selectors; the selector alone cannot establish ERC-20 semantics.
  if (!knownToken) return []
  const amount = (raw: string) => {
    if (request.kind === 'approve' && raw === MAX_UINT256) {
      return 'Unlimited'
    }
    return `${formatAmount(raw, knownToken.decimals)} ${knownToken.symbol}`
  }
  const addressRow = (label: string, value: string) =>
    reviewRow(label, formatSortAddress(value), { code: true, title: value })
  return [
    reviewRow('Requested method', request.kind, { code: true }),
    ...(request.kind === 'approve'
      ? [
          addressRow('Requested spender', request.spender),
          reviewRow('Requested allowance', amount(request.amountRaw), {
            code: true,
            breakAll: true
          })
        ]
      : request.kind === 'transfer'
        ? [
            addressRow('Requested recipient', request.recipient),
            reviewRow('Requested amount', amount(request.amountRaw), { code: true, breakAll: true })
          ]
        : [
            addressRow('Requested sender', request.sender),
            addressRow('Requested recipient', request.recipient),
            reviewRow('Requested amount', amount(request.amountRaw), { code: true, breakAll: true })
          ])
  ]
}

function clearsPermit2TokenAllowance(
  authorization: NonNullable<ReturnType<typeof decodeEvmAuthorizationCall>>
): boolean {
  if (authorization.kind === 'erc20-approve') {
    return (
      authorization.amountRaw === '0' && authorization.spender.toLowerCase() === PERMIT2_CONTRACT
    )
  }
  // approve(spender, 0) is the usual clear. decreaseAllowance is the fallback when that call reverts.
  return (
    authorization.kind === 'erc20-decrease-allowance' &&
    authorization.spender.toLowerCase() === PERMIT2_CONTRACT
  )
}

function assertNever(value: never): never {
  throw new Error(`Unsupported signing summary item: ${JSON.stringify(value)}`)
}

function formatWeiPerGasAsGwei(value: string | null): string | null {
  if (value === null) return null
  return `${formatEvmWeiAsGwei(value)} GWEI`
}

function typedDataRows(
  label: string,
  value: EvmTypedDataValue
): readonly SigningSummaryReviewRow[] {
  switch (value.kind) {
    case 'scalar':
      const breakAll = value.solidityType === 'address' || value.solidityType.startsWith('bytes')
      return [
        reviewRow(label, `${value.solidityType} · ${value.value}`, {
          code: true,
          ...(breakAll ? { breakAll: true } : {})
        })
      ]
    case 'struct':
      return value.fields.length === 0
        ? [reviewRow(label, `${value.typeName} (empty)`)]
        : value.fields.flatMap(field => typedDataRows(`${label}.${field.name}`, field.value))
    case 'array':
      return value.items.length === 0
        ? [reviewRow(label, `${value.itemType}[] (empty)`)]
        : value.items.flatMap((item, index) => typedDataRows(`${label}[${index}]`, item))
    default:
      return assertNever(value)
  }
}

function nearActionRows(
  action: NearActionSummary,
  index: number,
  context: { readonly signerId: string; readonly receiverId: string }
): readonly SigningSummaryReviewRow[] {
  const prefix = `Action ${index + 1}`
  switch (action.kind) {
    case 'create-account':
      return [reviewRow(prefix, 'Create account')]
    case 'deploy-contract':
      return [
        reviewRow(prefix, 'Deploy contract'),
        ...payloadDigestRows('Contract code', action.code)
      ]
    case 'function-call':
      return [
        reviewRow(prefix, 'Function call'),
        reviewRow('Method', action.methodName, { code: true }),
        ...nearFunctionCallReviewRows(action.methodName, action.args, {
          signerId: context.signerId,
          tokenContractId: context.receiverId
        }),
        reviewRow('Gas', action.gas, { code: true }),
        reviewRow('Deposit', `${action.depositYocto} yoctoNEAR`, { code: true }),
        ...canonicalContentRows('Arguments', action.args)
      ]
    case 'transfer':
      return [
        reviewRow(prefix, 'Transfer'),
        reviewRow('Deposit', `${action.depositYocto} yoctoNEAR`, { code: true })
      ]
    case 'stake':
      return [
        reviewRow(prefix, 'Stake'),
        reviewRow('Stake', `${action.stakeYocto} yoctoNEAR`, { code: true }),
        reviewRow('Validator key', action.publicKey, { code: true, breakAll: true })
      ]
    case 'add-key':
      return [
        reviewRow(prefix, 'Add access key'),
        reviewRow('Public key', action.publicKey, { code: true, breakAll: true }),
        reviewRow('Nonce', action.nonce, { code: true }),
        reviewRow(
          'Permission',
          action.permission.kind === 'full-access'
            ? 'Full access'
            : `Function call · ${action.permission.receiverId}`,
          { tone: action.permission.kind === 'full-access' ? 'warning' : 'default' }
        ),
        ...(action.permission.kind === 'function-call'
          ? [
              reviewRow(
                'Allowance',
                action.permission.allowanceYocto === null
                  ? 'Unlimited'
                  : `${action.permission.allowanceYocto} yoctoNEAR`,
                { code: true }
              ),
              reviewRow(
                'Methods',
                action.permission.methodNames.length === 0
                  ? 'All methods'
                  : action.permission.methodNames.join(', '),
                { code: true, breakAll: true }
              )
            ]
          : [])
      ]
    case 'delete-key':
      return [
        reviewRow(prefix, 'Delete access key'),
        reviewRow('Public key', action.publicKey, { code: true, breakAll: true })
      ]
    case 'delete-account':
      return [
        reviewRow(prefix, 'Delete account', { tone: 'danger' }),
        reviewRow('Beneficiary', action.beneficiaryId, { code: true, breakAll: true })
      ]
    case 'unrecognized':
      return [
        reviewRow(prefix, `Unknown action tag ${action.actionTag}`, { tone: 'danger' }),
        ...payloadDigestRows('Action payload', action.payload)
      ]
    default:
      return assertNever(action)
  }
}

export function zcashTransactionReview(
  summary: ZcashTransactionSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: summary.fields.kind === 'shield' ? 'Shield Zcash' : 'Send Zcash',
    ...(summary.fields.kind === 'shield'
      ? { description: 'Moves transparent funds into the shielded pool.' }
      : {}),
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('Funding source', summary.fields.fundingSource),
          reviewRow('Fee', `${summary.fields.feeZats} zats`, { code: true }),
          reviewRow('Transparent inputs', `${summary.fields.transparentInputZats} zats`, {
            code: true
          }),
          reviewRow('Shielded inputs', `${summary.fields.shieldedInputZats} zats`, { code: true }),
          reviewRow('Transparent outputs', `${summary.fields.transparentOutputZats} zats`, {
            code: true
          }),
          reviewRow('Shielded outputs', `${summary.fields.shieldedOutputZats} zats`, { code: true })
        ]
      },
      {
        title: `Recipients (${summary.fields.recipients.length})`,
        rows: summary.fields.recipients.flatMap((recipient, index) => [
          reviewRow(`Address ${index + 1}`, recipient.address, { code: true, breakAll: true }),
          reviewRow(`Amount ${index + 1}`, `${recipient.amountZats} zats`, { code: true }),
          ...(recipient.memo ? canonicalContentRows(`Memo ${index + 1}`, recipient.memo) : [])
        ])
      }
    ]
  })
}

export function zcashMessageReview(summary: ZcashMessageSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Zcash message',
    description: 'Signing proves control of this address and does not move funds.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}

function evmOnChainTokenAuthorization(
  summary: EvmTransactionSummary,
  options: EvmReviewPresentationOptions
): TokenAuthorizationReview | undefined {
  const contract = summary.fields.to
  if (contract === null || summary.fields.calldata.encoding !== 'hex') return undefined
  const authorization = decodeEvmAuthorizationCall(summary.fields.calldata.value, contract)
  if (!authorization) return undefined
  const tokenFields = (
    tokenContract: string,
    raw: string,
    unlimitedUnit: UnlimitedAmountUnit | undefined
  ) => {
    const identity = presentTokenIdentity(options, tokenContract, unlimitedUnit ? '0' : raw)
    return {
      symbol: identity.symbol,
      amount: unlimitedUnit ? 'Unlimited' : identity.amount,
      ...(identity.selfReportedName === undefined
        ? {}
        : { selfReportedName: identity.selfReportedName }),
      ...(unlimitedUnit === undefined ? {} : { unlimitedUnit })
    }
  }
  switch (authorization.kind) {
    case 'erc20-approve':
      return {
        protocol: 'ERC-20',
        kind: 'allowance',
        ...(clearsPermit2TokenAllowance(authorization)
          ? { effect: 'revoke-permit2' as const }
          : {}),
        owner: summary.fields.from,
        spender: authorization.spender,
        signatureDeadline: 'On submission',
        tokens: [
          {
            contractAddress: contract,
            assetId: `${summary.chainId}/erc20:${contract.toLowerCase()}`,
            ...tokenFields(
              contract,
              authorization.amountRaw,
              authorization.unlimited ? 'uint256' : undefined
            ),
            unlimited: authorization.unlimited
          }
        ]
      }
    case 'erc20-increase-allowance':
      return {
        protocol: 'ERC-20',
        kind: 'allowance',
        owner: summary.fields.from,
        spender: authorization.spender,
        signatureDeadline: 'On submission',
        tokens: [
          {
            contractAddress: contract,
            assetId: `${summary.chainId}/erc20:${contract.toLowerCase()}`,
            ...tokenFields(contract, authorization.amountRaw, undefined),
            unlimited: false
          }
        ]
      }
    case 'erc20-decrease-allowance':
      return {
        protocol: 'ERC-20',
        kind: 'allowance',
        ...(clearsPermit2TokenAllowance(authorization)
          ? { effect: 'revoke-permit2' as const }
          : {}),
        owner: summary.fields.from,
        spender: authorization.spender,
        signatureDeadline: 'On submission',
        tokens: [
          {
            contractAddress: contract,
            assetId: `${summary.chainId}/erc20:${contract.toLowerCase()}`,
            ...tokenFields(contract, authorization.amountRaw, undefined),
            unlimited: false
          }
        ]
      }
    case 'erc721-set-approval-for-all':
      return {
        protocol: 'ERC-721',
        kind: 'allowance',
        owner: summary.fields.from,
        spender: authorization.operator,
        signatureDeadline: 'On submission',
        tokens: [
          {
            contractAddress: contract,
            assetId: `${summary.chainId}/erc721:${contract.toLowerCase()}`,
            symbol: null,
            amount: authorization.approved
              ? 'All token IDs'
              : presentEvmRevocationLabel(options.rpcOrigin),
            unlimited: authorization.approved
          }
        ]
      }
    case 'permit2-approve':
      return {
        protocol: 'Permit2',
        kind: 'allowance',
        owner: summary.fields.from,
        spender: authorization.spender,
        signatureDeadline:
          authorization.expirationRaw === '0' ? 'On submission' : authorization.expirationRaw,
        tokens: [
          {
            contractAddress: authorization.token,
            assetId: `${summary.chainId}/erc20:${authorization.token.toLowerCase()}`,
            ...tokenFields(
              authorization.token,
              authorization.amountRaw,
              authorization.unlimited ? 'uint160' : undefined
            ),
            unlimited: authorization.unlimited,
            ...(authorization.expirationRaw !== '0'
              ? { expiration: authorization.expirationRaw }
              : {})
          }
        ]
      }
    case 'permit2-lockdown':
      return {
        protocol: 'Permit2',
        kind: 'allowance',
        effect: 'lockdown',
        owner: summary.fields.from,
        spender: authorization.pairs.length === 1 ? authorization.pairs[0]!.spender : '',
        signatureDeadline: 'On submission',
        tokens: authorization.pairs.map(pair => ({
          contractAddress: pair.token,
          assetId: `${summary.chainId}/erc20:${pair.token.toLowerCase()}`,
          ...tokenFields(pair.token, '0', undefined),
          amount: 'Cleared',
          unlimited: false
        }))
      }
    default:
      return assertNever(authorization)
  }
}

function signedSimulationAmount(
  direction: 'incoming' | 'outgoing',
  amountRaw: string,
  decimals?: number
): string {
  const magnitude =
    decimals === undefined ? amountRaw : formatBaseUnitDecimalAmount(amountRaw, decimals)
  return `${direction === 'incoming' ? '+' : '−'}${magnitude}`
}

function nativeSimulationCurrency(
  currency: EvmReviewPresentationOptions['nativeCurrency']
): { readonly symbol: string; readonly decimals: number } | undefined {
  if (
    currency === undefined ||
    currency.symbol.trim() !== currency.symbol ||
    currency.symbol.length === 0 ||
    [...currency.symbol].length > 32 ||
    !Number.isSafeInteger(currency.decimals) ||
    currency.decimals < 0 ||
    currency.decimals > 255
  ) {
    return undefined
  }
  return currency
}

function evmSimulationAssetChangeRows(
  summary: EvmTransactionSummary,
  options: EvmReviewPresentationOptions
): readonly SigningSummaryReviewRow[] {
  if (options.simulationTransfers === undefined) return []
  const currency = nativeSimulationCurrency(options.nativeCurrency)
  return aggregateEvmSimulationAssetChanges({
    account: summary.fields.from,
    tokenTransfers: options.simulationTransfers.tokenTransfers,
    traceTransfers: options.simulationTransfers.traceTransfers,
    tokens: options.tokenMetadata
  }).map(change => {
    if (change.kind === 'native') {
      return reviewRow(
        currency?.symbol ?? 'Native',
        currency
          ? `${signedSimulationAmount(change.direction, change.amountRaw, currency.decimals)} ${currency.symbol}`
          : `${signedSimulationAmount(change.direction, change.amountRaw)} wei`,
        { code: true }
      )
    }
    if (change.verification === 'unverified') {
      return reviewRow(
        change.reportedName === undefined ? 'Unverified' : 'Self-reported',
        change.reportedName === undefined
          ? `${signedSimulationAmount(change.direction, change.amountRaw)}\n${change.contractAddress}`
          : `${change.reportedName}\n${signedSimulationAmount(change.direction, change.amountRaw)}\n${change.contractAddress}`,
        { code: true, breakAll: true, title: change.contractAddress }
      )
    }
    if (change.verification === 'user-approved') {
      return reviewRow(
        'Self-reported',
        `${change.symbol}\n${signedSimulationAmount(change.direction, change.amountRaw, change.decimals)} ${change.symbol}\n${change.contractAddress}`,
        { code: true, breakAll: true, title: change.contractAddress }
      )
    }
    return reviewRow(
      change.symbol,
      `${signedSimulationAmount(change.direction, change.amountRaw, change.decimals)} ${change.symbol}`,
      { code: true, title: change.contractAddress }
    )
  })
}

export function evmTransactionReview(
  summary: EvmTransactionSummary,
  options: EvmReviewPresentationOptions = {}
): SigningSummaryReviewModel {
  const currency = options.nativeCurrency
  const tokenAuthorization = evmOnChainTokenAuthorization(summary, options)
  const requestedTokenCallRows = evmRequestedTokenCallRows(summary, options)
  const assetChangeRows = evmSimulationAssetChangeRows(summary, options)
  const amountRow = (label: string, raw: string) => {
    if (!currency) return reviewRow(label, `${raw} wei`, { code: true })
    const value = formatAmount(raw, currency.decimals)
    const profile = label === 'Maximum fee' || label === 'L1 data fee' ? 'fee' : 'review'
    return reviewRow(
      label,
      `${profile === 'fee' ? formatFeeAmount(value) : formatReviewAmount(value).display} ${currency.symbol}`,
      {
        code: true,
        amount: { value, symbol: currency.symbol, profile }
      }
    )
  }
  const authorizationDescription =
    tokenAuthorization?.effect === 'lockdown'
      ? PERMIT2_LOCKDOWN_EFFECT
      : tokenAuthorization?.effect === 'revoke-permit2'
        ? PERMIT2_TOKEN_REVOKE_EFFECT
        : undefined
  return completeReviewModel(summary, {
    title:
      tokenAuthorization?.effect === 'lockdown'
        ? 'Clear Permit2 allowance'
        : tokenAuthorization !== undefined
          ? 'Token authorization'
          : summary.fields.to === null
            ? 'Create contract'
            : 'Review EVM transaction',
    ...(tokenAuthorization !== undefined ? { tokenAuthorization } : {}),
    ...(authorizationDescription !== undefined
      ? { description: authorizationDescription }
      : summary.fields.to === null
        ? { description: 'Deploys a new smart contract.' }
        : {}),
    sections: [
      ...(assetChangeRows.length > 0 ? [{ title: 'Asset changes', rows: assetChangeRows }] : []),
      {
        title: 'Transaction',
        rows: [
          reviewRow('From', formatSortAddress(summary.fields.from), {
            code: true,
            title: summary.fields.from
          }),
          reviewRow(
            summary.fields.to !== null && summary.fields.calldata.value !== '0x'
              ? 'Contract'
              : 'To',
            summary.fields.to === null ? null : formatSortAddress(summary.fields.to),
            {
              code: true,
              title: summary.fields.to ?? undefined
            }
          ),
          amountRow(
            summary.fields.to === null || summary.fields.calldata.value !== '0x'
              ? 'Native value'
              : 'Value',
            summary.fields.valueWei
          ),
          amountRow('Maximum fee', summary.fields.maximumFeeWei),
          ...(summary.fields.l1DataFeeWei !== undefined && BigInt(summary.fields.l1DataFeeWei) > 0n
            ? [amountRow('L1 data fee', summary.fields.l1DataFeeWei)]
            : []),
          ...(options.directContract ? [reviewRow('Execution', 'Public on-chain')] : []),
          reviewRow('Gas limit', summary.fields.gasLimit, { code: true }),
          reviewRow('Nonce', summary.fields.nonce, { code: true }),
          reviewRow('Transaction type', summary.fields.transactionType),
          reviewRow('Method selector', summary.fields.methodSelector, { code: true }),
          reviewRow('Gas price', formatWeiPerGasAsGwei(summary.fields.gasPriceWei), { code: true }),
          reviewRow('Max fee per gas', formatWeiPerGasAsGwei(summary.fields.maxFeePerGasWei), {
            code: true
          }),
          reviewRow(
            'Priority fee per gas',
            formatWeiPerGasAsGwei(summary.fields.maxPriorityFeePerGasWei),
            { code: true }
          )
        ]
      },
      ...(requestedTokenCallRows.length > 0
        ? [{ title: 'Calldata request', rows: requestedTokenCallRows }]
        : []),
      {
        title: 'Contract data',
        rows: [
          ...canonicalContentRows('Calldata', summary.fields.calldata),
          reviewRow('Access list entries', summary.fields.accessList.length)
        ]
      },
      ...untrustedRpcSection(options.rpcOrigin)
    ]
  })
}

function untrustedRpcSection(origin: EvmRpcOrigin | undefined) {
  if (origin === undefined || origin === 'builtin') return []
  const unknown = (label: 'Simulation' | 'Balance check' | 'Authorization check') =>
    reviewRow(label, 'UNKNOWN')
  return [
    {
      title: 'Network node',
      rows: [
        reviewRow('RPC', evmRpcOriginLabel(origin)),
        unknown('Simulation'),
        unknown('Balance check'),
        unknown('Authorization check'),
        reviewRow('Node', 'Unverified node')
      ]
    }
  ]
}

export function evmPersonalMessageReview(
  summary: EvmPersonalMessageSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign EVM message',
    description:
      'A signature can authorize off-chain actions. It does not directly submit a transaction.',
    sections: [
      {
        title: 'Message',
        rows: [...canonicalContentRows('Content', summary.fields.message)]
      }
    ]
  })
}

function permitTime(raw: string, expiration = false): string {
  const seconds = BigInt(raw)
  if (expiration && seconds === 0n) return 'On submission'
  // Keep timestamps outside the Date range exact instead of rendering an invalid date.
  if (seconds > 8_640_000_000_000n) return `Unix time ${raw}`
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC'
  }).format(new Date(Number(seconds) * 1_000))} UTC`
}

const SEAPORT_ITEM_TYPES = [
  'Native token',
  'ERC-20',
  'ERC-721',
  'ERC-1155',
  'ERC-721 criteria',
  'ERC-1155 criteria'
]
const SEAPORT_ORDER_TYPES = ['Full open', 'Partial open', 'Full restricted', 'Partial restricted']

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function addressReviewRow(label: string, value: string, warning = false): SigningSummaryReviewRow {
  return reviewRow(label, value, {
    code: true,
    breakAll: true,
    ...(warning ? { tone: 'warning' as const } : {})
  })
}

function labeledEnum(labels: readonly string[], value: number): string {
  return labels[value] ?? `Unknown (${value})`
}

function domainNameClaim(
  domain: EvmTypedDataValue
): { readonly name?: string; readonly contract?: string } | undefined {
  if (domain.kind !== 'struct') return undefined
  const nameField = domain.fields.find(field => field.name === 'name')
  const contractField = domain.fields.find(field => field.name === 'verifyingContract')
  if (nameField?.value.kind !== 'scalar' || nameField.value.solidityType !== 'string') {
    return undefined
  }
  const name = readDisplayText(nameField.value.value, MAXIMUM_REPORTED_NAME_CODE_POINTS)
  const contract =
    contractField?.value.kind === 'scalar' &&
    contractField.value.solidityType === 'address' &&
    TOKEN_ADDRESS_PATTERN.test(contractField.value.value)
      ? contractField.value.value
      : undefined
  return {
    ...(name === undefined ? {} : { name }),
    ...(contract === undefined ? {} : { contract })
  }
}

function domainNameForToken(
  summary: EvmTypedDataSummary,
  contractAddress: string
): string | undefined {
  const claim = domainNameClaim(summary.fields.domain)
  if (!claim?.name || !claim.contract || !sameContractAddress(claim.contract, contractAddress)) {
    return undefined
  }
  return claim.name
}

function labeledDomainRows(
  summary: EvmTypedDataSummary,
  options: EvmReviewPresentationOptions
): readonly SigningSummaryReviewRow[] {
  const rows = typedDataRows('Domain', summary.fields.domain)
  const claim = domainNameClaim(summary.fields.domain)
  if (!claim) return rows
  const bundled = claim.contract ? bundledToken(options, claim.contract) : undefined
  const matchesBundled =
    claim.name !== undefined &&
    bundled !== undefined &&
    (claim.name === bundled.symbol || claim.name === bundled.name)
  if (matchesBundled) return rows
  const value = [
    claim.name === undefined ? 'Self-reported' : `Self-reported · ${claim.name}`,
    ...(claim.contract === undefined ? [] : [claim.contract])
  ].join('\n')
  return rows.map(row =>
    row.label === 'Domain.name'
      ? reviewRow('Domain.name', value, {
          code: true,
          ...(claim.contract === undefined ? {} : { breakAll: true })
        })
      : row
  )
}

function evmTokenAuthorization(
  summary: EvmTypedDataSummary,
  options: EvmReviewPresentationOptions,
  recognized: EvmTypedDataRecognition | null
): TokenAuthorizationReview | undefined {
  if (recognized?.kind === 'permit') {
    const permit = recognized.permit
    return {
      protocol: permit.protocol,
      kind: permit.kind,
      owner: permit.owner,
      spender: permit.spender,
      signatureDeadline: permit.deadlineUnbounded
        ? 'No expiry'
        : permitTime(permit.signatureDeadlineRaw),
      ...(permit.witnessReceivers ? { witnessReceivers: permit.witnessReceivers } : {}),
      tokens: permit.tokens.map(token => {
        const unlimitedUnit =
          permit.kind === 'allowance'
            ? unlimitedAllowanceUnit(token.amountRaw, token.amountBits)
            : undefined
        const formatted = presentTokenIdentity(
          options,
          token.contractAddress,
          unlimitedUnit ? '0' : token.amountRaw,
          domainNameForToken(summary, token.contractAddress)
        )
        return {
          contractAddress: token.contractAddress,
          assetId: `${summary.chainId}/erc20:${token.contractAddress.toLowerCase()}`,
          symbol: formatted.symbol,
          amount: unlimitedUnit ? 'Unlimited' : formatted.amount,
          ...(formatted.selfReportedName === undefined
            ? {}
            : { selfReportedName: formatted.selfReportedName }),
          unlimited: unlimitedUnit !== undefined,
          ...(unlimitedUnit === undefined ? {} : { unlimitedUnit }),
          ...(token.expirationRaw !== undefined
            ? { expiration: permitTime(token.expirationRaw, true) }
            : {})
        }
      })
    }
  }
  if (recognized?.kind !== 'eip3009-transfer') return undefined
  const transfer = recognized.transfer
  const formatted = presentTokenIdentity(
    options,
    transfer.verifyingContract,
    transfer.valueRaw,
    domainNameForToken(summary, transfer.verifyingContract)
  )
  return {
    protocol: 'EIP-3009',
    kind: 'transfer',
    owner: transfer.from,
    spender: '',
    recipient: transfer.to,
    signatureDeadline: permitTime(transfer.validBeforeRaw),
    validAfter: transfer.validAfterRaw === '0' ? 'Immediately' : permitTime(transfer.validAfterRaw),
    submission:
      transfer.variant === 'receive' ? 'Only the recipient can submit' : 'Relayers can submit',
    tokens: [
      {
        contractAddress: transfer.verifyingContract,
        assetId: `${summary.chainId}/erc20:${transfer.verifyingContract.toLowerCase()}`,
        symbol: formatted.symbol,
        amount: formatted.amount,
        ...(formatted.selfReportedName === undefined
          ? {}
          : { selfReportedName: formatted.selfReportedName }),
        unlimited: false
      }
    ]
  }
}

function seaportRows(order: EvmSeaportOrder): SigningSummaryReviewRow[] {
  const rows: SigningSummaryReviewRow[] = [
    addressReviewRow('Offerer', order.offerer),
    addressReviewRow('Zone', order.zone),
    reviewRow('Order type', labeledEnum(SEAPORT_ORDER_TYPES, order.orderType)),
    reviewRow('Start', permitTime(order.startTimeRaw)),
    reviewRow('End', permitTime(order.endTimeRaw))
  ]
  let offers = 0
  let considerations = 0
  for (const item of order.items) {
    const index = item.side === 'offer' ? ++offers : ++considerations
    const prefix = item.side === 'offer' ? `Offer ${index}` : `Consideration ${index}`
    rows.push(
      reviewRow(prefix, labeledEnum(SEAPORT_ITEM_TYPES, item.itemType)),
      addressReviewRow(`${prefix} token`, item.token),
      reviewRow(`${prefix} identifier`, item.identifier, { code: true, breakAll: true }),
      reviewRow(
        `${prefix} amount`,
        item.startAmount === item.endAmount
          ? item.startAmount
          : `${item.startAmount} to ${item.endAmount}`,
        { code: true, breakAll: true }
      )
    )
    if (item.recipient) {
      rows.push(
        addressReviewRow(
          `${prefix} recipient`,
          item.recipient,
          !sameAddress(item.recipient, order.offerer)
        )
      )
    }
  }
  return rows
}

function blurRows(order: EvmBlurOrder): SigningSummaryReviewRow[] {
  const rows: SigningSummaryReviewRow[] = [
    reviewRow(
      'Side',
      order.side === 0 ? 'Buy' : order.side === 1 ? 'Sell' : `Unknown (${order.side})`
    ),
    addressReviewRow('Trader', order.trader),
    addressReviewRow('Collection', order.collection),
    reviewRow('Token ID', order.tokenId, { code: true, breakAll: true }),
    reviewRow('Amount', order.amountRaw, { code: true, breakAll: true }),
    addressReviewRow('Payment token', order.paymentToken),
    reviewRow('Price', order.priceRaw, { code: true, breakAll: true }),
    reviewRow('Listing time', permitTime(order.listingTimeRaw)),
    reviewRow(
      'Expiration',
      order.expirationTimeRaw === '0' ? 'Oracle cancellation' : permitTime(order.expirationTimeRaw)
    )
  ]
  for (const [index, fee] of order.fees.entries()) {
    const prefix = `Fee ${index + 1}`
    rows.push(
      reviewRow(prefix, `${fee.rate} bps`),
      addressReviewRow(`${prefix} recipient`, fee.recipient)
    )
  }
  return rows
}

function receiverOrderRows(order: EvmReceiverOrder): SigningSummaryReviewRow[] {
  const inch = order.protocol === '1inch'
  const rows: SigningSummaryReviewRow[] = [
    addressReviewRow(inch ? 'Maker' : 'Signing account', order.account),
    addressReviewRow(inch ? 'Maker asset' : 'Sell token', order.sellToken),
    reviewRow(inch ? 'Making amount' : 'Sell amount', order.sellAmountRaw, {
      code: true,
      breakAll: true
    }),
    addressReviewRow(inch ? 'Taker asset' : 'Buy token', order.buyToken),
    reviewRow(inch ? 'Taking amount' : 'Buy amount', order.buyAmountRaw, {
      code: true,
      breakAll: true
    }),
    addressReviewRow(
      'Receiver',
      order.receiverIsDefault
        ? `${inch ? 'Maker' : 'Signing account'} · ${order.account}`
        : order.receiver,
      !order.receiverIsDefault && !sameAddress(order.receiver, order.account)
    )
  ]
  if (order.expiryRaw !== null) rows.push(reviewRow('Valid to', permitTime(order.expiryRaw)))
  return rows
}

function safeRows(transaction: EvmSafeTx): SigningSummaryReviewRow[] {
  return [
    addressReviewRow('Safe', transaction.safe),
    addressReviewRow('To', transaction.to),
    reviewRow('Value', `${transaction.valueRaw} wei`, { code: true, breakAll: true }),
    transaction.operation === 0
      ? reviewRow('Operation', 'Call')
      : reviewRow(
          'Operation',
          transaction.operation === 1 ? 'DelegateCall' : `Unknown (${transaction.operation})`,
          { tone: 'warning' }
        ),
    addressReviewRow('Refund receiver', transaction.refundReceiver),
    reviewRow('Nonce', transaction.nonce, { code: true })
  ]
}

function recognizedSignatureRows(
  recognized: EvmTypedDataRecognition | null
): readonly SigningSummaryReviewRow[] {
  switch (recognized?.kind) {
    case 'seaport':
      return seaportRows(recognized.order)
    case 'blur':
      return blurRows(recognized.order)
    case 'receiver-order':
      return receiverOrderRows(recognized.order)
    case 'safe-tx':
      return safeRows(recognized.transaction)
    case 'eip3009-cancel':
      return [
        addressReviewRow('Token contract', recognized.cancel.verifyingContract),
        addressReviewRow('Authorizer', recognized.cancel.authorizer),
        reviewRow('Nonce', recognized.cancel.nonce, { code: true, breakAll: true })
      ]
    case 'permit':
    case 'eip3009-transfer':
    case undefined:
      return []
    default: {
      const unsupported: never = recognized
      return unsupported
    }
  }
}

function recognizedDescription(recognized: EvmTypedDataRecognition | null): string {
  switch (recognized?.kind) {
    case 'eip3009-cancel':
      return 'This signature cancels one EIP-3009 transfer authorization.'
    case 'seaport':
      return 'This signature creates a Seaport order.'
    case 'blur':
      return 'This signature creates a Blur order.'
    case 'receiver-order':
      return recognized.order.protocol === '1inch'
        ? 'This signature creates a 1inch limit order.'
        : 'This signature creates a CoW Protocol order.'
    case 'safe-tx':
      return 'This signature authorizes a Safe transaction.'
    default:
      return 'This signature may authorize off-chain or on-chain actions.'
  }
}

function recognizedTitle(
  recognized: EvmTypedDataRecognition | null,
  tokenAuthorization: TokenAuthorizationReview | undefined
): string {
  if (tokenAuthorization) {
    return tokenAuthorization.kind === 'transfer'
      ? 'Token transfer authorization'
      : 'Token authorization'
  }
  switch (recognized?.kind) {
    case 'eip3009-cancel':
      return 'Cancel token authorization'
    case 'seaport':
      return 'Seaport order'
    case 'blur':
      return 'Blur order'
    case 'receiver-order':
      return recognized.order.protocol === '1inch' ? '1inch order' : 'CoW order'
    case 'safe-tx':
      return 'Safe transaction'
    default:
      return 'Sign typed data'
  }
}

export function evmTypedDataReview(
  summary: EvmTypedDataSummary,
  options: EvmReviewPresentationOptions = {}
): SigningSummaryReviewModel {
  const recognized = decodeEvmTypedDataRecognition(summary)
  const tokenAuthorization = evmTokenAuthorization(summary, options, recognized)
  const recognizedRows = recognizedSignatureRows(recognized)
  return completeReviewModel(summary, {
    title: recognizedTitle(recognized, tokenAuthorization),
    ...(tokenAuthorization
      ? { tokenAuthorization }
      : { description: recognizedDescription(recognized) }),
    sections: [
      ...(recognizedRows.length > 0
        ? [{ title: 'Recognized signature', rows: recognizedRows }]
        : []),
      {
        title: 'Typed data',
        rows: [
          reviewRow('Primary type', summary.fields.primaryType, { code: true }),
          ...labeledDomainRows(summary, options),
          ...typedDataRows('Message', summary.fields.message),
          reviewRow('Digest', summary.fields.digestHex, { code: true, breakAll: true })
        ]
      }
    ]
  })
}

export function bitcoinPsbtReview(summary: BitcoinPsbtSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Bitcoin transaction',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('PSBT version', summary.fields.psbtVersion),
          reviewRow('Total input', `${summary.fields.totalInputSats} sats`, { code: true }),
          reviewRow('Total output', `${summary.fields.totalOutputSats} sats`, { code: true }),
          reviewRow('Fee', `${summary.fields.feeSats} sats`, { code: true }),
          reviewRow('Signing inputs', summary.fields.signingInputIndexes.join(', '), { code: true })
        ]
      },
      {
        title: `Outputs (${summary.fields.outputs.length})`,
        rows: summary.fields.outputs.flatMap(output => [
          reviewRow(`Output ${output.index + 1}`, output.classification),
          reviewRow('Address', output.address, { code: true, breakAll: true }),
          reviewRow('Amount', `${output.amountSats} sats`, { code: true }),
          reviewRow('Script', output.scriptPubKeyHex, { code: true, breakAll: true })
        ])
      },
      {
        title: `Inputs (${summary.fields.inputs.length})`,
        rows: summary.fields.inputs.flatMap(input => [
          reviewRow(`Input ${input.index + 1}`, input.ownership),
          reviewRow('Outpoint', `${input.transactionId}:${input.outputIndex}`, {
            code: true,
            breakAll: true
          }),
          reviewRow('Amount', `${input.amountSats} sats`, { code: true }),
          reviewRow('Sighash', input.sighashType, { code: true })
        ])
      }
    ]
  })
}

export function bitcoinMessageReview(
  summary: BitcoinBip322MessageSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Bitcoin message',
    description: 'BIP-322 proves control of the selected Bitcoin address.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Address', summary.fields.address, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}

export function solanaTransactionReview(
  summary: SolanaTransactionSummary
): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Solana transaction',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Message version', summary.fields.messageVersion),
          reviewRow('Fee payer', summary.fields.feePayer, { code: true, breakAll: true }),
          reviewRow('Recent blockhash', summary.fields.recentBlockhash, {
            code: true,
            breakAll: true
          }),
          reviewRow('Required signers', summary.fields.requiredSigners.join('\n'), {
            code: true,
            breakAll: true
          }),
          reviewRow('Address table lookups', summary.fields.addressTableLookups.length),
          reviewRow(
            'RPC total fee',
            summary.fields.feeLamports === null
              ? 'Unavailable'
              : `${summary.fields.feeLamports} lamports`,
            { code: true }
          ),
          reviewRow('Compute unit limit', summary.fields.computeUnitLimit, { code: true }),
          reviewRow(
            'CU price',
            summary.fields.computeUnitPriceMicroLamports === null
              ? null
              : `${summary.fields.computeUnitPriceMicroLamports} micro-lamports/CU`,
            { code: true }
          ),
          reviewRow(
            'Max priority fee',
            summary.fields.maximumPriorityFeeLamports === null
              ? null
              : `${summary.fields.maximumPriorityFeeLamports} lamports`,
            { code: true }
          ),
          reviewRow('Simulation', summary.fields.simulationStatus),
          reviewRow('Simulated units', summary.fields.simulationUnitsConsumed, { code: true })
        ]
      },
      {
        title: `Instructions (${summary.fields.instructions.length})`,
        rows: summary.fields.instructions.flatMap(instruction => {
          const interpretation = instruction.interpretation
          const interpretedRows: SigningSummaryReviewRow[] = []
          switch (interpretation.kind) {
            case 'system-transfer':
              interpretedRows.push(
                reviewRow('Action', 'System transfer'),
                reviewRow('From', interpretation.from, { code: true, breakAll: true }),
                reviewRow('To', interpretation.to, { code: true, breakAll: true }),
                reviewRow('Amount', `${interpretation.lamports} lamports`, { code: true })
              )
              break
            case 'spl-token-transfer':
              interpretedRows.push(
                reviewRow('Action', 'SPL token transfer'),
                reviewRow('Source', interpretation.source, { code: true, breakAll: true }),
                reviewRow('Destination', interpretation.destination, {
                  code: true,
                  breakAll: true
                }),
                reviewRow('Authority', interpretation.authority, { code: true, breakAll: true }),
                reviewRow('Raw amount', interpretation.amountRaw, { code: true }),
                reviewRow('Mint', interpretation.mint, { code: true, breakAll: true })
              )
              break
            case 'associated-token-create-idempotent':
              interpretedRows.push(
                reviewRow('Action', 'Create associated token account if needed'),
                reviewRow('Payer', interpretation.payer, { code: true, breakAll: true }),
                reviewRow('Owner', interpretation.owner, { code: true, breakAll: true }),
                reviewRow('Token account', interpretation.associatedAccount, {
                  code: true,
                  breakAll: true
                }),
                reviewRow('Mint', interpretation.mint, { code: true, breakAll: true })
              )
              break
            case 'compute-unit-limit':
              interpretedRows.push(
                reviewRow('Action', 'Set compute unit limit'),
                reviewRow('Units', interpretation.units, { code: true })
              )
              break
            case 'compute-unit-price':
              interpretedRows.push(
                reviewRow('Action', 'Set compute unit price'),
                reviewRow('Price', `${interpretation.microLamports} micro-lamports/CU`, {
                  code: true
                })
              )
              break
            case 'compute-request-heap-frame':
              interpretedRows.push(
                reviewRow('Action', 'Request heap frame'),
                reviewRow('Bytes', interpretation.bytes, { code: true })
              )
              break
            case 'compute-loaded-accounts-data-size-limit':
              interpretedRows.push(
                reviewRow('Action', 'Set loaded account data limit'),
                reviewRow('Bytes', interpretation.bytes, { code: true })
              )
              break
            case 'compute-request-units-deprecated':
              interpretedRows.push(
                reviewRow('Action', 'Request compute units (legacy)'),
                reviewRow('Units', interpretation.units, { code: true }),
                reviewRow('Additional fee', `${interpretation.additionalFeeLamports} lamports`, {
                  code: true
                })
              )
              break
            case 'unrecognized':
              interpretedRows.push(reviewRow('Action', 'Unknown instruction', { tone: 'danger' }))
              break
            default:
              assertNever(interpretation)
          }
          return [
            reviewRow(`Instruction ${instruction.index + 1}`, instruction.programId, {
              code: true,
              breakAll: true
            }),
            ...interpretedRows,
            ...canonicalContentRows('Instruction data', instruction.data)
          ]
        })
      }
    ]
  })
}

export function solanaMessageReview(summary: SolanaMessageSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign Solana message',
    description: 'Signing proves control of this account and does not submit a transaction.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Signer', summary.fields.signer, { code: true, breakAll: true }),
          reviewRow('Domain', summary.fields.domain, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}

export function nearTransactionReview(summary: NearTransactionSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign NEAR transaction',
    sections: [
      {
        title: 'Transaction',
        rows: [
          reviewRow('Signer', summary.fields.signerId, { code: true, breakAll: true }),
          reviewRow('Receiver', summary.fields.receiverId, { code: true, breakAll: true }),
          reviewRow('Public key', summary.fields.publicKey, { code: true, breakAll: true }),
          reviewRow('Nonce', summary.fields.nonce, { code: true }),
          reviewRow('Block hash', summary.fields.blockHash, { code: true, breakAll: true })
        ]
      },
      {
        title: `Actions (${summary.fields.actions.length})`,
        rows: summary.fields.actions.flatMap((action, index) =>
          nearActionRows(action, index, {
            signerId: summary.fields.signerId,
            receiverId: summary.fields.receiverId
          })
        )
      }
    ]
  })
}

export function nearMessageReview(summary: NearNep413MessageSummary): SigningSummaryReviewModel {
  return completeReviewModel(summary, {
    title: 'Sign NEP-413 message',
    description: 'This signature may authorize actions for the stated recipient.',
    sections: [
      {
        title: 'Message',
        rows: [
          reviewRow('Signer', summary.fields.signerId, { code: true, breakAll: true }),
          reviewRow('Public key', summary.fields.publicKey, { code: true, breakAll: true }),
          reviewRow('Recipient', summary.fields.recipient, { code: true, breakAll: true }),
          reviewRow('Callback URL', summary.fields.callbackUrl, { breakAll: true }),
          reviewRow('Nonce', summary.fields.nonceBase64, { code: true, breakAll: true }),
          ...canonicalContentRows('Content', summary.fields.message)
        ]
      }
    ]
  })
}
