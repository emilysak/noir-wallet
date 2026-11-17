import { isAddress } from 'viem'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import { getZcashChainId } from '@/core/chains/registry'
import type { Network } from '@/types'

function isCaseSensitiveChain(chainId: string): boolean {
  return (
    chainId.startsWith('near:') || chainId.startsWith('solana:') || chainId.startsWith('zcash:')
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
