import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { parseNearAccountId } from '@/core/chains/near'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'

import { createConfiguredNearRpcClient } from './near-configured-rpc-client'
import { NearRpcError, type NearFungibleTokenMetadata } from './near-rpc-types'

export interface InspectedNearCustomToken extends NearFungibleTokenMetadata {
  readonly chainId: string
}

function nearTokenVerificationError(error: unknown): Error {
  if (error instanceof NearRpcError) {
    switch (error.code) {
      case 'account-not-found':
        return new Error('This NEAR account was not found.')
      case 'chain-mismatch':
        return new Error('The NEAR RPC endpoint does not match this network.')
      case 'rate-limited':
        return new Error('NEAR RPC is busy. Try again.')
      case 'timeout':
      case 'network-unavailable':
        return new Error('NEAR RPC could not be reached. Check the network and try again.')
      case 'unauthorized':
        return new Error('NEAR RPC authorization failed.')
      case 'invalid-response':
        return new Error('This contract did not return valid NEP-141 token metadata.')
      default:
        return new Error('This NEAR account did not return NEP-141 token metadata.')
    }
  }
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 256)
    return error
  return new Error('This contract did not return valid NEP-141 token metadata.')
}

/**
 * Reads NEP-141 ft_metadata from the active network RPC.
 * Callers persist the returned metadata for the selected account.
 */
export async function inspectUserNearAsset(
  chainIdValue: unknown,
  contractIdValue: unknown
): Promise<InspectedNearCustomToken> {
  const network = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, getActiveChainEndpointSettings())
  if (chainIdValue !== network.chainId) {
    throw new Error('Token verification is only available for the active NEAR network.')
  }
  let contractId: string
  try {
    contractId = parseNearAccountId(contractIdValue, 'NEAR token contract account')
  } catch {
    throw new Error('Enter a valid NEAR token contract account.')
  }
  const rpc = createConfiguredNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  try {
    await rpc.assertExpectedChain()
    const metadata = await rpc.getFungibleTokenMetadata(contractId)
    return Object.freeze({
      chainId: network.chainId,
      contractId: metadata.contractId,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals
    })
  } catch (error) {
    throw nearTokenVerificationError(error)
  }
}
