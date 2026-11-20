import Big from '@/lib/big'
import type {
  PortfolioAssetView,
  PortfolioBalanceView,
  PortfolioChainView,
  PortfolioReadModel,
  ConfidentialPortfolioView
} from '@/core/portfolio'
import type { AssetRegistry, AssetRegistryEntry } from '@/core/chains/registry'
import { getBitcoinChainId, getZcashChainId } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { Network } from '@/types'
import { NATIVE_CONFIDENTIAL_PROTOCOL_ASSETS } from './native-confidential-protocol-assets'

export interface ConfidentialPortfolioBalance {
  readonly tokenId: string
  readonly available: string
}

export interface ConfidentialPortfolioAssetMapping {
  readonly assetId: string
  readonly protocolAssetId: string
}

function nativeConfidentialPortfolioAssetId(protocolAssetId: string): string | null {
  const alias = NATIVE_CONFIDENTIAL_PROTOCOL_ASSETS.find(
    item => item.protocolAssetId === protocolAssetId
  )
  return alias ? `${alias.chainId}/slip44:${alias.reference}` : null
}

function readRegistryAsset(assets: AssetRegistry, assetId: string) {
  try {
    return assets.get(assetId)
  } catch {
    return undefined
  }
}

function hasNativeConfidentialMapping(
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  protocolAssetId: string
): boolean {
  const nativeAssetId = nativeConfidentialPortfolioAssetId(protocolAssetId)
  return (
    nativeAssetId !== null &&
    mappings.some(
      mapping => mapping.assetId === nativeAssetId && mapping.protocolAssetId === protocolAssetId
    )
  )
}

// A wrapped catalog row and the native coin share one protocol asset. The home
// list keeps that balance on the native asset, so a later NEP-141 mapping must
// not replace slip44:397, slip44:501, or Bitcoin slip44:0.
function mappedConfidentialAssetId(
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  protocolAssetId: string
): string | undefined {
  if (hasNativeConfidentialMapping(mappings, protocolAssetId)) {
    return nativeConfidentialPortfolioAssetId(protocolAssetId) ?? undefined
  }
  return mappings.find(mapping => mapping.protocolAssetId === protocolAssetId)?.assetId
}

function registeredNativeConfidentialAsset(
  protocolAssetId: string,
  assets: AssetRegistry,
  tokenDecimals: number | undefined
) {
  const assetId = nativeConfidentialPortfolioAssetId(protocolAssetId)
  if (!assetId) return undefined
  const registered = readRegistryAsset(assets, assetId)
  if (!registered) return undefined
  if (
    tokenDecimals !== undefined &&
    registered.metadata?.decimals !== undefined &&
    registered.metadata.decimals !== tokenDecimals
  ) {
    return undefined
  }
  return registered
}

export function filterConfidentialPortfolioMappings(
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  network: Network
): readonly ConfidentialPortfolioAssetMapping[] {
  const zcashAssetId = `${getZcashChainId(network)}/slip44:133`
  const bitcoinAssetId = `${getBitcoinChainId(network)}/slip44:0`
  return mappings.filter(
    mapping =>
      mapping.assetId.startsWith('eip155:') ||
      mapping.assetId.startsWith('near:') ||
      mapping.assetId.startsWith('solana:') ||
      mapping.assetId === bitcoinAssetId ||
      mapping.assetId === zcashAssetId
  )
}

function keepsConfidentialBalanceSeparate(assetId: string): boolean {
  return (
    assetId.startsWith('near:') ||
    assetId.startsWith('solana:') ||
    assetId.startsWith(`${getBitcoinChainId('mainnet')}/`) ||
    assetId.startsWith(`${getBitcoinChainId('testnet')}/`)
  )
}

// Mainnet uses this shared treasury namespace; arbitrary IMT suffix matches are not equivalent assets.
// https://docs.near-intents.org/integration/market-makers/confidential-intents
export const CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID =
  '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'

export function confidentialPrivateTokenId(protocolAssetId: string): string {
  return `imt:${CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID}:${protocolAssetId}`
}

export function mergeConfidentialSignerBalances(
  groups: readonly (readonly Readonly<{
    tokenId: string
    available: string
    source?: string
  }>[])[]
): readonly Readonly<{ tokenId: string; available: string; source: string }>[] {
  const totals = new Map<string, { available: bigint; source: string }>()
  for (const group of groups) {
    for (const row of group) {
      if (!row.tokenId || !/^(0|[1-9][0-9]*)$/.test(row.available)) continue
      const amount = BigInt(row.available)
      const current = totals.get(row.tokenId)
      if (current) {
        current.available += amount
        continue
      }
      totals.set(row.tokenId, { available: amount, source: row.source ?? '' })
    }
  }
  return Object.freeze(
    [...totals].map(([tokenId, row]) =>
      Object.freeze({
        tokenId,
        available: row.available.toString(),
        source: row.source
      })
    )
  )
}

export function getConfidentialAvailableForAsset(
  balances: readonly ConfidentialPortfolioBalance[],
  protocolAssetId: string
): string | null {
  const row =
    balances.find(balance => balance.tokenId === confidentialPrivateTokenId(protocolAssetId)) ??
    balances.find(balance => balance.tokenId === protocolAssetId)
  return row && /^(0|[1-9][0-9]*)$/.test(row.available) ? row.available : null
}

export function buildConfidentialPortfolioView(
  balances: readonly ConfidentialPortfolioBalance[],
  tokens: readonly SwapToken[],
  managedAssets: readonly IntentsManagedAsset[],
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  assets: AssetRegistry
): ConfidentialPortfolioView {
  const treasuryPrefix = `imt:${CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID}:`
  const byProtocolId = new Map<
    string,
    { balance: ConfidentialPortfolioBalance; priority: number }
  >()
  for (const balance of balances) {
    if (!/^(0|[1-9][0-9]*)$/.test(balance.available)) {
      throw new Error('Invalid Confidential balance')
    }
    const verifiedImt = balance.tokenId.startsWith(treasuryPrefix)
    const protocolAssetId = verifiedImt
      ? balance.tokenId.slice(treasuryPrefix.length)
      : balance.tokenId
    if (!protocolAssetId) throw new Error('Invalid Confidential token ID')
    const priority = verifiedImt ? 1 : 0
    const previous = byProtocolId.get(protocolAssetId)
    if (previous && previous.priority === priority) {
      throw new Error('Duplicate Confidential balance')
    }
    if (!previous || priority > previous.priority)
      byProtocolId.set(protocolAssetId, { balance, priority })
  }

  const tokenById = new Map(tokens.map(token => [token.assetId, token]))
  const managedById = new Map(managedAssets.map(asset => [asset.protocolAssetId, asset]))
  const entries = [...byProtocolId].flatMap(([protocolAssetId, { balance }]) => {
    if (balance.available === '0') return []
    const token = tokenById.get(protocolAssetId)
    if (isDeprecatedIntentsToken({ assetId: protocolAssetId, symbol: token?.symbol })) return []
    const managed = managedById.get(protocolAssetId)
    const mappedAssetId = mappedConfidentialAssetId(mappings, protocolAssetId)
    const mapped = mappedAssetId ? readRegistryAsset(assets, mappedAssetId) : undefined
    const native = registeredNativeConfidentialAsset(protocolAssetId, assets, token?.decimals)
    const registered = native ?? mapped
    const assetId = native?.asset.id ?? managed?.assetId ?? mapped?.asset.id
    const chainId = native?.asset.chainId ?? managed?.chainId ?? mapped?.asset.chainId
    const bundledMetadata =
      token &&
      registered?.source === 'bundled' &&
      assetId === registered.asset.id &&
      token.decimals === registered.metadata.decimals
        ? registered.metadata
        : null
    const iconUrl = token ? (token.icon ?? token.coingeckoIcon ?? undefined) : undefined
    const priceUsd = token && token.price > 0 ? new Big(token.price).toFixed() : undefined
    return [
      Object.freeze({
        tokenId: balance.tokenId,
        protocolAssetId,
        availableRaw: balance.available,
        ...(assetId ? { assetId } : {}),
        ...(chainId ? { chainId } : {}),
        ...(token
          ? {
              blockchain: token.blockchain,
              symbol: bundledMetadata?.symbol ?? token.symbol,
              name: bundledMetadata?.name ?? token.symbol,
              decimals: token.decimals,
              ...(iconUrl ? { iconUrl } : {}),
              ...(token.coingeckoId ? { coingeckoId: token.coingeckoId } : {}),
              ...(priceUsd && priceUsd.length <= 128
                ? {
                    priceUsd,
                    priceUpdatedAt: token.priceUpdatedAt
                  }
                : {})
            }
          : {})
      })
    ]
  })
  return Object.freeze({ status: 'ready', assets: Object.freeze(entries) })
}

function mergeAsset(
  asset: PortfolioAssetView,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  balances: readonly ConfidentialPortfolioBalance[],
  snapshot?: Readonly<{ freshness: 'fresh' | 'stale'; updatedAt: number }>
): PortfolioAssetView {
  const mapping = mappings.find(candidate => candidate.assetId === asset.asset.id)
  if (!mapping) return asset
  const nativeAssetId = nativeConfidentialPortfolioAssetId(mapping.protocolAssetId)
  if (
    nativeAssetId &&
    asset.asset.id !== nativeAssetId &&
    hasNativeConfidentialMapping(mappings, mapping.protocolAssetId)
  ) {
    return asset
  }
  const confidentialRaw = isDeprecatedIntentsToken({ assetId: mapping.protocolAssetId })
    ? '0'
    : (getConfidentialAvailableForAsset(balances, mapping.protocolAssetId) ?? '0')
  // NEAR, Solana, and Bitcoin keep the 1Click amount on confidentialRaw.
  // Their on-chain split stays main + private.
  if (keepsConfidentialBalanceSeparate(asset.asset.id)) {
    return Object.freeze({
      ...asset,
      balance: Object.freeze({
        ...asset.balance,
        confidentialRaw
      })
    })
  }
  if (asset.balance.mainRaw === undefined || asset.balance.privateRaw === undefined) {
    return asset
  }
  const previousConfidential = BigInt(asset.balance.confidentialRaw ?? '0')
  const privateOnchain = BigInt(
    asset.balance.privateOnchainRaw ??
      (BigInt(asset.balance.privateRaw) - previousConfidential).toString()
  )
  const nextConfidential = BigInt(confidentialRaw)
  const delta = nextConfidential - previousConfidential
  const addDelta = (raw: string) => (BigInt(raw) + delta).toString()
  return Object.freeze({
    ...asset,
    ...(snapshot?.freshness === 'stale'
      ? {
          freshness: 'stale' as const,
          updatedAt:
            typeof asset.updatedAt === 'number'
              ? Math.min(asset.updatedAt, snapshot.updatedAt)
              : snapshot.updatedAt
        }
      : {}),
    balance: Object.freeze({
      ...asset.balance,
      totalRaw: addDelta(asset.balance.totalRaw),
      privateRaw: (privateOnchain + nextConfidential).toString(),
      privateOnchainRaw: privateOnchain.toString(),
      confidentialRaw: nextConfidential.toString()
    })
  })
}

export function mergeConfidentialBalancesIntoPortfolio(
  model: PortfolioReadModel,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  balances: readonly ConfidentialPortfolioBalance[],
  snapshot?: Readonly<{ freshness: 'fresh' | 'stale'; updatedAt: number }>
): PortfolioReadModel {
  const assets = model.assets.map(asset => mergeAsset(asset, mappings, balances, snapshot))
  const byId = new Map(assets.map(asset => [asset.asset.id, asset]))
  const chains = model.chains.map(chain =>
    Object.freeze({
      ...chain,
      assets: Object.freeze(chain.assets.map(asset => byId.get(asset.asset.id) ?? asset)),
      ...(snapshot?.freshness === 'stale' &&
      chain.status === 'ready' &&
      chain.assets.some(asset => byId.get(asset.asset.id)?.freshness === 'stale')
        ? { status: 'partial' as const }
        : {})
    })
  )
  return Object.freeze({
    ...model,
    assets: Object.freeze(assets),
    chains: Object.freeze(chains),
    ...(snapshot?.freshness === 'stale' &&
    model.status === 'ready' &&
    chains.some(chain => chain.status === 'partial')
      ? { status: 'partial' as const }
      : {})
  })
}

function canProjectConfidentialOnlyAsset(
  entry: AssetRegistryEntry,
  chain: PortfolioChainView
): boolean {
  if (entry.asset.chainId !== chain.chain.id) return false
  if (chain.status !== 'ready' && chain.status !== 'partial') return false
  if (chain.chain.family === 'evm') return entry.asset.kind === 'token'
  if (chain.chain.network.kind !== 'mainnet') return false
  if (chain.chain.family === 'near') {
    return entry.asset.kind === 'native' || entry.asset.namespace === 'nep141'
  }
  if (chain.chain.family === 'solana') return true
  if (chain.chain.family === 'bitcoin') {
    return entry.asset.id === `${entry.asset.chainId}/slip44:0`
  }
  return false
}

function confidentialOnlyBalance(
  family: PortfolioChainView['chain']['family'],
  availableRaw: string
): PortfolioBalanceView {
  if (family === 'evm') {
    return Object.freeze({
      totalRaw: availableRaw,
      spendableRaw: '0',
      availableRaw: '0',
      pendingRaw: '0',
      mainRaw: '0',
      privateRaw: availableRaw,
      privateOnchainRaw: '0',
      confidentialRaw: availableRaw
    })
  }
  // On-chain total stays zero. The home list adds confidentialRaw for display.
  return Object.freeze({
    totalRaw: '0',
    spendableRaw: '0',
    availableRaw: '0',
    pendingRaw: '0',
    mainRaw: '0',
    privateRaw: '0',
    confidentialRaw: availableRaw
  })
}

export function projectConfidentialOnlyEvmAssets(
  model: PortfolioReadModel,
  confidential: ConfidentialPortfolioView,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  assets: AssetRegistry
): PortfolioReadModel {
  if (confidential.status !== 'ready') return model
  const existing = new Set<string>(model.assets.map(asset => asset.asset.id))
  const mappedByProtocolId = new Map(
    mappings.map(mapping => [
      mapping.protocolAssetId,
      mappedConfidentialAssetId(mappings, mapping.protocolAssetId)
    ])
  )
  const holdingCountByAssetId = new Map<string, number>()
  for (const holding of confidential.assets) {
    if (holding.assetId) {
      holdingCountByAssetId.set(
        holding.assetId,
        (holdingCountByAssetId.get(holding.assetId) ?? 0) + 1
      )
    }
  }
  const projected = confidential.assets.flatMap(holding => {
    const assetId = holding.assetId
    if (
      !assetId ||
      existing.has(assetId) ||
      mappedByProtocolId.get(holding.protocolAssetId) !== assetId ||
      holdingCountByAssetId.get(assetId) !== 1
    )
      return []
    const entry = assets.get(assetId)
    const chain = model.chains.find(item => item.chain.id === holding.chainId)
    const chainAccountIds = chain?.assets.find(
      asset => asset.chainAccountIds.length > 0
    )?.chainAccountIds
    if (
      !entry ||
      entry.metadata.decimals !== holding.decimals ||
      !chain ||
      !canProjectConfidentialOnlyAsset(entry, chain) ||
      !chainAccountIds
    )
      return []
    existing.add(assetId)
    return [
      Object.freeze({
        asset: entry.asset,
        metadata: entry.metadata,
        source: entry.source,
        balance: confidentialOnlyBalance(chain.chain.family, holding.availableRaw),
        chainAccountIds,
        freshness: confidential.freshness === 'stale' ? ('stale' as const) : ('fresh' as const),
        updatedAt: confidential.updatedAt ?? Date.now()
      }) satisfies PortfolioAssetView
    ]
  })
  if (projected.length === 0) return model
  const chains = model.chains.map(chain =>
    Object.freeze({
      ...chain,
      ...(confidential.freshness === 'stale' &&
      chain.status === 'ready' &&
      projected.some(asset => asset.asset.chainId === chain.chain.id)
        ? { status: 'partial' as const }
        : {}),
      assets: Object.freeze([
        ...chain.assets,
        ...projected.filter(asset => asset.asset.chainId === chain.chain.id)
      ])
    })
  )
  return Object.freeze({
    ...model,
    ...(confidential.freshness === 'stale' && model.status === 'ready'
      ? { status: 'partial' as const }
      : {}),
    chains: Object.freeze(chains),
    assets: Object.freeze(chains.flatMap(chain => chain.assets))
  })
}

export function excludeDeprecatedConfidentialAssets(model: PortfolioReadModel): PortfolioReadModel {
  const confidential = model.confidential
  if (!confidential) return model
  const hidden = confidential.assets.filter(asset =>
    isDeprecatedIntentsToken({ assetId: asset.protocolAssetId, symbol: asset.symbol })
  )
  if (hidden.length === 0) return model
  const visible = confidential.assets.filter(asset => !hidden.includes(asset))
  const hiddenMappings = new Map(
    hidden.flatMap(asset =>
      asset.assetId
        ? [
            [
              asset.assetId,
              {
                assetId: asset.assetId,
                protocolAssetId:
                  visible.find(current => current.assetId === asset.assetId)?.protocolAssetId ??
                  asset.protocolAssetId
              }
            ] as const
          ]
        : []
    )
  )
  // Replace only the projected Shield portion; public and private on-chain balances stay intact.
  const projected = mergeConfidentialBalancesIntoPortfolio(
    model,
    [...hiddenMappings.values()],
    visible.map(asset => ({ tokenId: asset.tokenId, available: asset.availableRaw }))
  )
  return Object.freeze({
    ...projected,
    confidential: Object.freeze({ ...confidential, assets: Object.freeze(visible) })
  })
}
