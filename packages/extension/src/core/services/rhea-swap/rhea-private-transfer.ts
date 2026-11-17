import { WNEAR_NEAR_ASSET } from '@/config/intents'

import type { RheaSwapToken } from './rhea-swap-model'

export function resolveRheaPrivateTransferToken(
  tokens: readonly RheaSwapToken[],
  contractAddress: string | null
): RheaSwapToken | null {
  if (contractAddress === null) {
    return (
      tokens.find(token => token.isNative) ??
      tokens.find(
        token => token.assetId === WNEAR_NEAR_ASSET && token.blockchain.toLowerCase() === 'near'
      ) ??
      null
    )
  }
  const normalized = contractAddress.toLowerCase()
  return (
    tokens.find(token => !token.isNative && token.contractAddress?.toLowerCase() === normalized) ??
    null
  )
}
