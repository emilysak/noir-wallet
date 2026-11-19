import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import type { ChainId } from '@/core/chains/domain'
import { BITCOIN_CHAIN_IDS } from '@/core/chains/registry/chain-ids'

// 1Click generate-intent accepts nep413, erc191, raw_ed25519, webauthn, ton_connect,
// sep53, and tip191. bitcoin and bip322 are rejected, so a Bitcoin source still
// signs the intent with the existing EVM session. A deposit quote pays a bc1
// address. A withdraw quote's depositAddress is the 64-hex intents account and
// must not be spent with a PSBT.

const INTENTS_ACCOUNT_PATTERN = /^[0-9a-fA-F]{64}$/

export function isBitcoinConfidentialChain(chainId: string): chainId is ChainId {
  return chainId === BITCOIN_CHAIN_IDS.mainnet || chainId === BITCOIN_CHAIN_IDS.testnet
}

export function isConfidentialIntentsDepositAccount(address: string): boolean {
  return INTENTS_ACCOUNT_PATTERN.test(address)
}

export function assertBitcoinPayableDepositAddress(address: string, chainId: string): string {
  if (!isBitcoinConfidentialChain(chainId)) {
    throw new Error('Bitcoin deposit address must be a bc1 address')
  }
  // Withdraw generate-intent returns this account. It is not a chain payment.
  if (isConfidentialIntentsDepositAccount(address)) {
    throw new Error('Confidential withdraw deposit is not a Bitcoin payment')
  }
  let parsed: string
  try {
    parsed = parseSupportedBitcoinAddress(address, chainId)
  } catch {
    throw new Error('Bitcoin deposit address must be a bc1 address')
  }
  const prefix = chainId === BITCOIN_CHAIN_IDS.mainnet ? 'bc1' : 'tb1'
  // The deposit cluster pays a bc1q address. Any other encoding, including a
  // legacy address, is not payable.
  if (!parsed.startsWith(prefix)) {
    throw new Error('Bitcoin deposit address must be a bc1 address')
  }
  return parsed
}

export function assertBitcoinDepositAddress(address: string, chainId: string): string {
  if (!isBitcoinConfidentialChain(chainId)) throw new Error('Invalid Bitcoin address')
  try {
    return parseSupportedBitcoinAddress(address, chainId)
  } catch {
    throw new Error('Invalid Bitcoin address')
  }
}

export interface BitcoinDepositOutput {
  readonly address: string | null
}

export interface BitcoinConfidentialDepositPreparation {
  readonly commandId: string
  readonly payloadFingerprint: string
  readonly expiresAt: number
  readonly networkFeeRaw: string
  readonly signerAddress: string
  readonly outputs: readonly BitcoinDepositOutput[]
}

export interface BitcoinConfidentialDepositClient {
  resolvePublicSpendAddress(chainId: ChainId): Promise<{
    readonly sourceAddress: string
    readonly counterpartyAddress?: string
  }>
  preparePublicDeposit(input: {
    readonly chainId: ChainId
    readonly recipient: string
    readonly amountRaw: string
    readonly sourceAddress: string
    readonly counterpartyAddress?: string
  }): Promise<BitcoinConfidentialDepositPreparation>
  preparePrivateDeposit(input: {
    readonly chainId: ChainId
    readonly recipient: string
    readonly amountRaw: string
    readonly privateExecutionAddress: string
    readonly publicReceiveAddress: string
    readonly counterpartyAddress?: string
  }): Promise<BitcoinConfidentialDepositPreparation>
  confirmPublicDeposit(input: {
    readonly commandId: string
    readonly payloadFingerprint: string
  }): Promise<{ readonly rawTransaction: string; readonly transactionHash: string }>
  rejectDeposit(commandId: string): Promise<void>
}

export function assertBitcoinDepositOutputs(input: {
  readonly chainId: string
  readonly depositAddress: string
  readonly sourceAddress: string
  readonly counterpartyAddress?: string
  readonly outputs: readonly BitcoinDepositOutput[]
}): void {
  const depositAddress = assertBitcoinPayableDepositAddress(input.depositAddress, input.chainId)
  const sourceAddress = assertBitcoinDepositAddress(input.sourceAddress, input.chainId)
  const counterpartyAddress =
    input.counterpartyAddress === undefined
      ? undefined
      : assertBitcoinDepositAddress(input.counterpartyAddress, input.chainId)
  if (depositAddress === sourceAddress) {
    throw new Error(
      'Bitcoin deposit outputs must pay the quote address and return change to the source'
    )
  }
  if (
    counterpartyAddress !== undefined &&
    (counterpartyAddress === sourceAddress || counterpartyAddress === depositAddress)
  ) {
    throw new Error('Bitcoin deposit output pays another wallet address')
  }
  if (input.outputs.length < 1 || input.outputs.length > 2) {
    throw new Error(
      'Bitcoin deposit outputs must pay the quote address and return change to the source'
    )
  }
  let paidDeposit = false
  let changeCount = 0
  for (const output of input.outputs) {
    if (!output.address) {
      throw new Error('Bitcoin deposit output pays another wallet address')
    }
    const address = assertBitcoinDepositAddress(output.address, input.chainId)
    if (counterpartyAddress !== undefined && address === counterpartyAddress) {
      throw new Error('Bitcoin deposit output pays another wallet address')
    }
    if (address === depositAddress) {
      paidDeposit = true
      continue
    }
    if (address === sourceAddress) {
      changeCount += 1
      continue
    }
    throw new Error('Bitcoin deposit output pays another wallet address')
  }
  if (!paidDeposit || changeCount > 1) {
    throw new Error(
      'Bitcoin deposit outputs must pay the quote address and return change to the source'
    )
  }
}
