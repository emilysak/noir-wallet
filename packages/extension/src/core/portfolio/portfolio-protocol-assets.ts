import type { AssetDefinitionInput } from '@/core/chains/registry'

export function portfolioProtocolDefinitionId(definition: AssetDefinitionInput): string {
  const reference =
    definition.namespace === 'erc20' ? definition.reference.toLowerCase() : definition.reference
  return `${definition.chainId}/${definition.namespace}:${reference}`
}

export function selectPortfolioProtocolDefinitions(input: {
  readonly assetIds: ReadonlySet<string>
  readonly knownAssetIds: ReadonlySet<string>
  readonly definitions: readonly AssetDefinitionInput[]
}): readonly AssetDefinitionInput[] {
  const selected: AssetDefinitionInput[] = []
  const seen = new Set<string>()
  for (const definition of input.definitions) {
    const assetId = portfolioProtocolDefinitionId(definition)
    if (!input.assetIds.has(assetId) || input.knownAssetIds.has(assetId) || seen.has(assetId)) {
      continue
    }
    seen.add(assetId)
    selected.push(definition)
  }
  return Object.freeze(selected)
}

export function selectManagedProtocolAssetIds(input: {
  readonly protocolAssetIds: readonly string[]
  readonly heldAssetIds: ReadonlySet<string>
  readonly visibleAssetIds: ReadonlySet<string>
}): readonly string[] {
  return Object.freeze(
    input.protocolAssetIds.filter(
      assetId => input.heldAssetIds.has(assetId) || input.visibleAssetIds.has(assetId)
    )
  )
}

export function selectPricedProtocolMappings<T extends { readonly assetId: string }>(input: {
  readonly mappings: readonly T[]
  readonly visibleAssetIds: ReadonlySet<string>
  readonly heldAssetIds: ReadonlySet<string>
  readonly maximum: number
}): readonly T[] {
  if (!Number.isSafeInteger(input.maximum) || input.maximum <= 0) return Object.freeze([])
  const selected: T[] = []
  const seen = new Set<string>()
  const take = (mapping: T) => {
    if (selected.length >= input.maximum || seen.has(mapping.assetId)) return
    seen.add(mapping.assetId)
    selected.push(mapping)
  }
  for (const mapping of input.mappings) {
    if (input.visibleAssetIds.has(mapping.assetId)) take(mapping)
  }
  for (const mapping of input.mappings) {
    if (input.heldAssetIds.has(mapping.assetId)) take(mapping)
  }
  return Object.freeze(selected)
}
