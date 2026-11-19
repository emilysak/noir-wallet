import { isAddress } from 'viem'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import type { ChainId } from '@/core/chains/domain'
import { getZcashChainId } from '@/core/chains/registry'
import { BITCOIN_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import type { Network } from '@/types'

function isBitcoinChain(chainId: string): boolean {
  return chainId === BITCOIN_CHAIN_IDS.mainnet || chainId === BITCOIN_CHAIN_IDS.testnet
}

function isCaseSensitiveChain(chainId: string): boolean {
  return (
    chainId.startsWith('near:') ||
    chainId.startsWith('solana:') ||
    chainId.startsWith('zcash:') ||
    isBitcoinChain(chainId)
  )
}

export function isValidExternalRecipient(
  address: string,
  destinationChainId: string,
  network: Network
): boolean {
  if (destinationChainId === getZcashChainId(network)) {
    try {
      return parseZcashAddress(address, network).address === address
    } catch {
      return false
    }
  }
  if (destinationChainId.startsWith('near:')) {
    try {
      return parseNearAccountId(address) === address
    } catch {
      return false
    }
  }
  if (destinationChainId.startsWith('solana:')) {
    try {
      return parseSolanaPublicKey(address) === address
    } catch {
      return false
    }
  }
  if (isBitcoinChain(destinationChainId)) {
    try {
      return parseSupportedBitcoinAddress(address, destinationChainId as ChainId) === address
    } catch {
      return false
    }
  }
  return isAddress(address) && !/^0x0{40}$/i.test(address)
}

export function externalRecipientsMatch(
  left: string,
  right: string,
  destinationChainId: string,
  network: Network
): boolean {
  return destinationChainId === getZcashChainId(network) || isCaseSensitiveChain(destinationChainId)
    ? left === right
    : left.toLowerCase() === right.toLowerCase()
}
