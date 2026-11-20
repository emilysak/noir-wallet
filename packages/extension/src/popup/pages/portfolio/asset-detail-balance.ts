import Big from '@/lib/big'
import { getNearNetworkConfig } from '@/config/networks'
import { BITCOIN_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { excludeDeprecatedConfidentialAssets } from '@/core/services/confidential-funding/confidential-funding-portfolio'
import type { PortfolioAssetView, PortfolioBalanceView, PortfolioReadModel } from '@/core/portfolio'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { formatDisplayTokenAmount } from '@/popup/components/portfolio/portfolio-format'
import {
  getAssetDomainRaw,
  getAssetShieldProvider,
  type AssetDomain
} from '@/popup/services/asset-domains'

const NEAR_MAINNET_CHAIN_ID = getNearNetworkConfig('mainnet').chainId

export function sumZcashDetailBalanceRaw(
  nativeRaw: string | null,
  confidentialRaw: string | null
): string | null {
  return nativeRaw === null || confidentialRaw === null
    ? null
    : (BigInt(nativeRaw) + BigInt(confidentialRaw)).toString()
}

export function getAssetDetailCategories(
  asset: PortfolioAssetView,
  model: PortfolioReadModel,
  privateEligible: boolean,
  priceUsd?: string
): {
  domains: readonly AssetDomain[]
  raw: Record<AssetDomain, string | null>
  fiat: Record<AssetDomain, string | null>
} {
  const visibleModel = excludeDeprecatedConfidentialAssets(model)
  if (visibleModel !== model) {
    model = visibleModel
    asset = model.assets.find(candidate => candidate.asset.id === asset.asset.id) ?? asset
  }
  const evm = asset.asset.chainId.startsWith('eip155:')
  const solana = asset.asset.chainId.startsWith('solana:')
  const near = asset.asset.chainId.startsWith('near:')
  const nearShield =
    asset.asset.chainId === NEAR_MAINNET_CHAIN_ID &&
    (asset.asset.kind === 'native' || asset.asset.namespace === 'nep141')
  const bitcoin =
    (asset.asset.chainId === BITCOIN_CHAIN_IDS.mainnet ||
      asset.asset.chainId === BITCOIN_CHAIN_IDS.testnet) &&
    asset.asset.id === `${asset.asset.chainId}/slip44:0`
  const separateConfidential = solana || near || bitcoin
  const zcash = getAssetShieldProvider(asset) === 'zcash-shield'
  const raw: Record<AssetDomain, string | null> = {
    all: asset.balance.totalRaw,
    public: getAssetDomainRaw(asset, 'public'),
    shield: zcash ? getAssetDomainRaw(asset, 'shield') : null,
    private: evm || separateConfidential ? getAssetDomainRaw(asset, 'private') : null
  }
  let shieldPriceUsd: string | undefined

  if ((evm || solana || nearShield || bitcoin) && model.confidential?.status === 'ready') {
    const candidates = model.confidential.assets.filter(entry => entry.assetId === asset.asset.id)
    if (
      candidates.length === 1 &&
      candidates[0]!.chainId === asset.asset.chainId &&
      candidates[0]!.decimals === asset.metadata.decimals
    ) {
      raw.shield = candidates[0]!.availableRaw
      const candidatePrice = candidates[0]!.priceUsd
      if (
        candidatePrice &&
        candidatePrice.length <= 128 &&
        /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(candidatePrice) &&
        new Big(candidatePrice).gt(0)
      ) {
        shieldPriceUsd = candidatePrice
      }
    } else if (
      candidates.length === 0 &&
      (asset.balance.confidentialRaw === '0' || (separateConfidential && privateEligible))
    ) {
      raw.shield = '0'
    }
  }
  if (separateConfidential && raw.shield === null) {
    const domainShield = getAssetDomainRaw(asset, 'shield')
    if (domainShield !== null && BigInt(domainShield) > 0n) raw.shield = domainShield
  }
  if (separateConfidential && privateEligible && raw.shield === null) raw.shield = '0'
  if (separateConfidential && raw.public !== null && raw.private !== null && raw.shield !== null) {
    raw.all = (BigInt(raw.public) + BigInt(raw.private) + BigInt(raw.shield)).toString()
  }

  const domains: AssetDomain[] = ['all', 'public']
  if (zcash) domains.push('shield')
  if (
    (evm || separateConfidential) &&
    (privateEligible || (raw.shield !== null && BigInt(raw.shield) > 0n))
  ) {
    domains.push('shield')
  }
  if (
    (evm || separateConfidential) &&
    (privateEligible || (raw.private !== null && BigInt(raw.private) > 0n))
  ) {
    domains.push('private')
  }

  const fiat = Object.fromEntries(
    (['all', 'public', 'shield', 'private'] as const).map(domain => {
      const amount = raw[domain]
      const quote = domain === 'shield' ? (priceUsd ?? shieldPriceUsd) : priceUsd
      return [
        domain,
        amount === null || quote === undefined
          ? null
          : new Big(formatBaseUnitDecimalAmount(amount, asset.metadata.decimals))
              .times(quote)
              .toFixed()
      ]
    })
  ) as Record<AssetDomain, string | null>
  return { domains, raw, fiat }
}

export function getZcashPrivacyBalanceDisplay(balance: PortfolioBalanceView, decimals: number) {
  const formatPending = (raw: string | undefined) =>
    raw && BigInt(raw) > 0n ? formatDisplayTokenAmount(raw, decimals) : null

  return {
    shielded: formatDisplayTokenAmount(balance.shieldedRaw ?? '0', decimals),
    transparent: formatDisplayTokenAmount(balance.transparentRaw ?? '0', decimals),
    shieldedPending: formatPending(balance.shieldedPendingRaw),
    transparentPending: formatPending(balance.transparentPendingRaw)
  }
}
