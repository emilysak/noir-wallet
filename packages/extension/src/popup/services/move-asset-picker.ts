import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { getConfidentialAvailableForAsset } from '@/core/services/confidential-funding'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { Network } from '@/types'
import { getTransferDomainBalanceRaw, type TransferDomain } from './private-balance-transfer'
import { resolveShieldManagedAsset } from './shield-transfer'

type MoveAsset = Readonly<{ asset: PortfolioAssetView; chain: PortfolioChainView }>
type ShieldBalance = Readonly<{ tokenId: string; available: string }>

type MoveAssetPickerRow = MoveAsset & Readonly<{ sourceRaw: string; valueUsd: string | null }>

export function listMoveAssetPickerRows(input: {
  readonly assets: readonly MoveAsset[]
  readonly from: TransferDomain
  readonly network: Network
  readonly prices: AssetPriceReadModel | null
  readonly portfolio: PortfolioReadModel | null
  readonly shieldBalances: readonly ShieldBalance[] | null
  readonly managedAssets: readonly IntentsManagedAsset[]
  readonly catalogTokens: readonly SwapToken[]
}): readonly MoveAssetPickerRow[] {
  const rows = input.assets.flatMap(item => {
    const managed =
      input.from === 'shield'
        ? resolveShieldManagedAsset(
            item.asset,
            input.managedAssets,
            input.catalogTokens,
            input.network
          )
        : null
    const confidentialRaw =
      managed && input.shieldBalances
        ? getConfidentialAvailableForAsset(input.shieldBalances, managed.protocolAssetId)
        : null
    const sourceRaw =
      input.from === 'shield'
        ? (confidentialRaw ??
          (input.shieldBalances ? (item.asset.balance.confidentialRaw ?? '0') : null))
        : getTransferDomainBalanceRaw(item.asset, input.from)
    // A resolved zero stays selectable. Dropping it makes the reversed direction look empty.
    if (sourceRaw === null) return []

    const priceUsd =
      findAssetPrice(input.prices, item.asset.asset.id)?.priceUsd ??
      (managed
        ? input.portfolio?.confidential?.assets.find(
            holding => holding.protocolAssetId === managed.protocolAssetId
          )?.priceUsd
        : undefined)
    const valueUsd = priceUsd
      ? new Big(formatBaseUnitDecimalAmount(sourceRaw, item.asset.metadata.decimals))
          .times(priceUsd)
          .toFixed()
      : null
    return [{ ...item, sourceRaw, valueUsd }]
  })
  return rows.sort((left, right) => {
    if (left.valueUsd === null) return right.valueUsd === null ? 0 : 1
    if (right.valueUsd === null) return -1
    return new Big(right.valueUsd).cmp(left.valueUsd)
  })
}
