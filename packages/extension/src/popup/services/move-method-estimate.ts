import type { SigningSummary } from '@/core/keyring/domain'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { SwapToken } from '@/core/services/intents-api'
import { RHEA_SWAP_CHAIN_CATALOG, resolveRheaPrivateTransferToken } from '@/core/services/rhea-swap'
import { preferWalletEvmQuoteToken } from './token-address-discovery'
import type { ConfidentialFundingPreview } from '@/core/services/confidential-funding'
import { assertBitcoinPayableDepositAddress } from '@/core/services/confidential-funding/bitcoin-confidential-deposit'
import { findShieldCatalogToken } from './shield-transfer'
import { formatBaseUnitDecimalAmount, formatFeeAmount } from '@/lib/number-format'
import { evmWalletClient, type EvmFeeEstimate } from './evm-wallet-client'
import { rheaSwapClient } from './rhea-swap-client'
import { requiredRheaEvmApproval } from './rhea-evm-approval'
import { formatIntentsConfirmationTime } from './confirmation-time-format'

export interface MoveMethodEstimate {
  readonly expiresAt: number
  readonly routeFeeRaw: string | null
  readonly sourceNetworkFee?: {
    readonly raw: string
    readonly symbol: string
    readonly decimals: number
  }
  readonly time: string
}

const DIRECT_MAXIMUM_MINUTES = 5
const CLUSTER_MAXIMUM_MINUTES = 10 + 2 // Batch execution and arrival allowance.

function formatMoveTime(seconds: number | undefined, maximumMinutes: number): string {
  const range = formatIntentsConfirmationTime(seconds, maximumMinutes)
  return range === '—' ? `Up to ${maximumMinutes} min` : range
}

function routeFee(amountRaw: string, outputRaw: string): string | null {
  const difference = BigInt(amountRaw) - BigInt(outputRaw)
  return difference.toString()
}

export function clusterMoveEstimate(
  amountRaw: string,
  preview: ConfidentialFundingPreview
): MoveMethodEstimate {
  return {
    expiresAt: preview.expiresAt,
    routeFeeRaw: routeFee(amountRaw, preview.amountOutRaw),
    time: formatMoveTime(preview.timeEstimateSeconds, CLUSTER_MAXIMUM_MINUTES)
  }
}

export async function estimateDirectMove(input: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly nativeFeeAsset: PortfolioAssetView | null
  readonly amountRaw: string
  readonly sender: string
  readonly recipient: string
  readonly executionMode: 'main' | 'private'
  readonly signal: AbortSignal
}): Promise<MoveMethodEstimate> {
  const match = /^eip155:([1-9][0-9]*)$/.exec(input.chain.chain.id)
  if (!match) {
    if (
      input.chain.chain.network?.kind === 'mainnet' &&
      (input.chain.chain.family === 'near' ||
        input.chain.chain.family === 'solana' ||
        input.chain.chain.family === 'bitcoin')
    ) {
      return estimateConfidentialChainMove(input)
    }
    throw new Error('Unsupported Move network')
  }
  const catalog = await rheaSwapClient
    .listTokens({ direction: 'from', tokenListChainIds: [Number(match[1])] })
    .catch(() => null)
  input.signal.throwIfAborted()
  const catalogToken = resolveRheaPrivateTransferToken(
    catalog?.tokens ?? [],
    input.asset.asset.kind === 'token' ? input.asset.asset.reference : null
  )
  const token = preferWalletEvmQuoteToken(input.asset, catalogToken)
  if (!token) throw new Error('Move source asset could not be mapped to a quote token')
  const asset = {
    chain: token.rheaChainId,
    address: token.rheaAddress,
    symbol: token.symbol,
    decimals: token.decimals,
    isNative: token.isNative
  }
  const quote = await rheaSwapClient.quote(
    {
      fromChain: token.rheaChainId,
      toChain: token.rheaChainId,
      tokenIn: asset,
      tokenOut: asset,
      amountIn: input.amountRaw,
      sender: input.sender,
      recipient: input.recipient,
      slippageBps: 100,
      confidentiality: 'basic'
    },
    input.executionMode === 'private' ? 'private-transfer' : 'confidential-funding'
  )
  try {
    input.signal.throwIfAborted()
    let result: MoveMethodEstimate = {
      expiresAt: Math.min(quote.expiresAt ?? Infinity, Date.now() + 30_000),
      routeFeeRaw: routeFee(input.amountRaw, quote.estimatedOut),
      time: formatMoveTime(undefined, DIRECT_MAXIMUM_MINUTES)
    }
    // A route quote remains useful when RPC cannot estimate its source gas.
    try {
      const review = await rheaSwapClient.prepare(quote.quoteHandle)
      input.signal.throwIfAborted()
      result = {
        ...result,
        time: formatMoveTime(review.timeEstimateSeconds, DIRECT_MAXIMUM_MINUTES)
      }
      if (review.execution.kind !== 'evm-transaction') return result
      const plan = await rheaSwapClient.getEvmTransactionPlan(quote.quoteHandle)
      input.signal.throwIfAborted()
      const approval = await requiredRheaEvmApproval({
        approval: plan.approval,
        chainId: input.chain.chain.id,
        owner: input.sender,
        executionMode: input.executionMode,
        getTokenAllowance: evmWalletClient.getTokenAllowance
      })
      const calls = [...(approval ? [approval.transaction] : []), plan.transaction]
      const fees: EvmFeeEstimate[] = []
      for (const call of calls) {
        input.signal.throwIfAborted()
        fees.push(
          await evmWalletClient.estimateContractCallFee(
            {
              chainId: input.chain.chain.id,
              contractAddress: call.to,
              valueRaw: call.value,
              calldata: call.data
            },
            { executionMode: input.executionMode }
          )
        )
      }
      input.signal.throwIfAborted()
      return {
        ...result,
        ...(input.nativeFeeAsset
          ? {
              sourceNetworkFee: {
                raw: fees.reduce((sum, item) => sum + BigInt(item.maximumFeeWei), 0n).toString(),
                symbol: input.nativeFeeAsset.metadata.symbol,
                decimals: input.nativeFeeAsset.metadata.decimals
              }
            }
          : {})
      }
    } catch {
      input.signal.throwIfAborted()
      return result
    }
  } finally {
    await rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
  }
}

export function findDirectConfidentialChainToken<T extends SwapToken>(
  tokens: readonly T[],
  asset: Pick<PortfolioAssetView, 'asset' | 'metadata'>
): T | undefined {
  return findShieldCatalogToken(asset, tokens, 'mainnet')
}

function confidentialChainTokenListId(family: string): number | null {
  if (family !== 'near' && family !== 'solana' && family !== 'bitcoin') return null
  return (
    RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.walletFamily === family)?.tokenListChainId ?? null
  )
}

type ConfidentialChainMoveInput = Parameters<typeof estimateDirectMove>[0]
type ConfidentialChainQuoteClient = Pick<
  typeof rheaSwapClient,
  'listTokens' | 'quote' | 'prepare' | 'discard'
>

const BITCOIN_DEPOSIT_EXECUTION = 'bitcoin-transfer'
const BITCOIN_MOVE_DEPOSIT_ERROR = 'Bitcoin move must pay the quote deposit address.'

export interface BitcoinDirectMoveQuote {
  readonly failed: boolean
  readonly routeMissing: boolean
  readonly executionKind: string | null
  readonly depositAddress: string | null
}

export type BitcoinDirectMoveSettlement =
  | {
      readonly kind: 'deposit'
      readonly sourceAddress: string
      readonly depositAddress: string
      readonly outputs: readonly [{ readonly address: string; readonly purpose: 'deposit' }]
    }
  | { readonly kind: 'stop'; readonly error: string }

export function settleBitcoinDirectMoveQuote(input: {
  readonly chainId: string
  readonly sourceAddress: string
  readonly counterpartyAddress: string
  readonly quote: BitcoinDirectMoveQuote | null
}): BitcoinDirectMoveSettlement {
  const stop = (error: string): BitcoinDirectMoveSettlement =>
    Object.freeze({ kind: 'stop', error })
  if (!input.quote || input.quote.failed || input.quote.routeMissing) {
    return stop('Move route unavailable')
  }
  if (input.quote.executionKind !== BITCOIN_DEPOSIT_EXECUTION || !input.quote.depositAddress) {
    return stop(BITCOIN_MOVE_DEPOSIT_ERROR)
  }
  let depositAddress: string
  try {
    depositAddress = assertBitcoinPayableDepositAddress(input.quote.depositAddress, input.chainId)
  } catch (error) {
    return stop(error instanceof Error ? error.message : BITCOIN_MOVE_DEPOSIT_ERROR)
  }
  // The other wallet address is never an output. Change stays with the source signer.
  if (depositAddress === input.sourceAddress || depositAddress === input.counterpartyAddress) {
    return stop(BITCOIN_MOVE_DEPOSIT_ERROR)
  }
  const settlement: BitcoinDirectMoveSettlement = {
    kind: 'deposit',
    sourceAddress: input.sourceAddress,
    depositAddress,
    outputs: [{ address: depositAddress, purpose: 'deposit' }]
  }
  return settlement
}

export function assertBitcoinDirectMovePreparedOutputs(input: {
  readonly depositAddress: string
  readonly amountRaw: string
  readonly summary: SigningSummary
}): void {
  const outputs = input.summary.schema === 'bitcoin.psbt.v1' ? input.summary.fields.outputs : []
  const recipients = outputs.filter(output => output.classification === 'recipient')
  const recipient = recipients.length === 1 ? recipients[0] : null
  if (
    !recipient ||
    recipient.address !== input.depositAddress ||
    recipient.amountSats !== input.amountRaw
  ) {
    throw new Error(BITCOIN_MOVE_DEPOSIT_ERROR)
  }
}

async function quoteConfidentialChainMove(
  input: ConfidentialChainMoveInput,
  client: Pick<ConfidentialChainQuoteClient, 'listTokens' | 'quote'>
) {
  const tokenListChainId = confidentialChainTokenListId(input.chain.chain.family)
  if (tokenListChainId === null) throw new Error('Move route unavailable')
  const catalog = await client.listTokens({
    direction: 'from',
    tokenListChainIds: [tokenListChainId]
  })
  input.signal.throwIfAborted()
  const token = findDirectConfidentialChainToken(catalog.tokens, input.asset)
  if (!token || token.decimals !== input.asset.metadata.decimals) {
    throw new Error('Move route unavailable')
  }
  const asset = {
    chain: token.rheaChainId,
    address: token.rheaAddress,
    symbol: token.symbol,
    decimals: token.decimals,
    isNative: token.isNative
  }
  const quote = await client.quote(
    {
      fromChain: token.rheaChainId,
      toChain: token.rheaChainId,
      tokenIn: asset,
      tokenOut: asset,
      amountIn: input.amountRaw,
      sender: input.sender,
      recipient: input.recipient,
      slippageBps: 100,
      confidentiality: 'basic'
    },
    input.executionMode === 'private' ? 'private-transfer' : 'confidential-funding'
  )
  return { quote, tokenListChainId }
}

async function estimateConfidentialChainMove(
  input: ConfidentialChainMoveInput
): Promise<MoveMethodEstimate> {
  const quoted = await quoteConfidentialChainMove(input, rheaSwapClient)
  try {
    input.signal.throwIfAborted()
    return {
      expiresAt: Math.min(quoted.quote.expiresAt ?? Infinity, Date.now() + 30_000),
      routeFeeRaw: routeFee(input.amountRaw, quoted.quote.estimatedOut),
      time: '—',
      timeScope: 'Network only'
    }
  } finally {
    await rheaSwapClient.discard(quoted.quote.quoteHandle).catch(() => {})
  }
}

export async function settleBitcoinDirectMove(
  input: ConfidentialChainMoveInput,
  client: ConfidentialChainQuoteClient = rheaSwapClient
): Promise<BitcoinDirectMoveSettlement> {
  if (input.chain.chain.family !== 'bitcoin' || input.chain.chain.network?.kind !== 'mainnet') {
    return Object.freeze({ kind: 'stop', error: 'Move route unavailable' })
  }
  let quoteHandle: string | null = null
  try {
    const quoted = await quoteConfidentialChainMove(input, client)
    quoteHandle = quoted.quote.quoteHandle
    input.signal.throwIfAborted()
    const review = await client.prepare(quoteHandle)
    input.signal.throwIfAborted()
    return settleBitcoinDirectMoveQuote({
      chainId: input.chain.chain.id,
      sourceAddress: input.sender,
      counterpartyAddress: input.recipient,
      quote: {
        failed: false,
        routeMissing: false,
        executionKind: review.execution.kind,
        depositAddress: review.execution.target
      }
    })
  } catch (error) {
    if (input.signal.aborted) throw error
    const message =
      error instanceof Error && error.message ? error.message : 'Move route unavailable'
    return Object.freeze({ kind: 'stop', error: message })
  } finally {
    if (quoteHandle) await client.discard(quoteHandle).catch(() => {})
  }
}

export function formatMoveMethodFee(
  estimate: MoveMethodEstimate | null,
  asset: PortfolioAssetView | null
): { value: string; detail: string | null } {
  if (!estimate || !asset || estimate.routeFeeRaw === null) return { value: '—', detail: null }
  const gas = estimate.sourceNetworkFee
  const format = (raw: string, decimals: number) => {
    const value = BigInt(raw)
    return `${value < 0n ? '-' : ''}${formatFeeAmount(formatBaseUnitDecimalAmount(value < 0n ? -value : value, decimals))}`
  }
  if (gas && asset.asset.kind === 'native')
    return {
      value: `~${format((BigInt(estimate.routeFeeRaw) + BigInt(gas.raw)).toString(), asset.metadata.decimals)} ${asset.metadata.symbol}`,
      detail: null
    }
  return {
    value: `~${format(estimate.routeFeeRaw, asset.metadata.decimals)} ${asset.metadata.symbol}`,
    detail: gas ? `+\u00a0~${format(gas.raw, gas.decimals)} ${gas.symbol}` : '+ network fee'
  }
}
