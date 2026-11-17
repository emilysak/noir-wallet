import { ASSET_PRICE_SOURCE_ASSETS } from '@/config/asset-market-assets'
import { WNEAR_NEAR_ASSET } from '@/config/intents'
import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import type { Network } from '@/types'
import type { SwapToken } from '@/core/services/intents-api'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import { createIntentsWalletAssetCatalog } from '@/core/services/intents-wallet-assets'

import type { ConfidentialPortfolioAssetMapping } from './confidential-funding-portfolio'

export interface ConfidentialFundingAssetLookup {
  get(assetId: string): { readonly metadata: { readonly decimals: number } } | undefined
}

// Wrapped NEAR and SOL rows keep a contract address, so the wallet catalog treats
// them as NEP-141. Confidential moves still spend the native coin through that
// protocol asset when the registered decimals match.
export const NATIVE_CONFIDENTIAL_PROTOCOL_ASSETS = Object.freeze([
  Object.freeze({
    chainId: getNearNetworkConfig('mainnet').chainId,
    reference: '397',
    protocolAssetId: WNEAR_NEAR_ASSET,
    blockchain: 'near'
  }),
  Object.freeze({
    chainId: getSolanaNetworkConfig('mainnet').chainId,
    reference: '501',
    protocolAssetId: ASSET_PRICE_SOURCE_ASSETS.sol,
    blockchain: 'sol'
  })
])

export function addConfidentialWalletChainMappings(
  mappings: Map<string, ConfidentialPortfolioAssetMapping>,
  assets: ConfidentialFundingAssetLookup,
  protocolTokens: readonly SwapToken[],
  network: Network
): void {
  try {
    for (const entry of createIntentsWalletAssetCatalog(protocolTokens, network).entries) {
      if (!entry.chainId.startsWith('near:') && !entry.chainId.startsWith('solana:')) continue
      if (mappings.has(entry.assetId)) continue
      mappings.set(
        entry.assetId,
        Object.freeze({
          assetId: entry.assetId,
          protocolAssetId: entry.protocolAssetId
        })
      )
    }
  } catch {
    // A conflicting catalog must not drop EVM mappings or skip native aliases.
  }

  if (network !== 'mainnet') return
  for (const alias of NATIVE_CONFIDENTIAL_PROTOCOL_ASSETS) {
    const assetId = `${alias.chainId}/slip44:${alias.reference}`
    if (mappings.has(assetId)) continue
    // A build without this chain rejects the lookup. That must not block EVM funding.
    let registered: { readonly metadata: { readonly decimals: number } } | undefined
    try {
      registered = assets.get(assetId)
    } catch {
      continue
    }
    if (!registered) continue
    const matched = protocolTokens.some(
      token =>
        token.assetId === alias.protocolAssetId &&
        token.blockchain.toLowerCase() === alias.blockchain.toLowerCase() &&
        token.decimals === registered.metadata.decimals &&
        !isDeprecatedIntentsToken(token)
    )
    if (!matched) continue
    mappings.set(
      assetId,
      Object.freeze({
        assetId,
        protocolAssetId: alias.protocolAssetId
      })
    )
  }
}
