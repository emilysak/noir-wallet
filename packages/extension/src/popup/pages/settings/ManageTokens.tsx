import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { formatSortAddress } from '@/lib/format'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { createInitialProductChainRegistry } from '@/core/chains/registry'
import type { DetectedEvmAssetRecord, UserEvmAssetRecord } from '@/core/chains/user-assets'
import {
  findManagedIntentsAssetByReference,
  type IntentsManagedAsset
} from '@/core/services/intents-managed-assets'
import { nearCustomTokenAssetId } from '@/infrastructure/chains/near/near-custom-tokens'
import type { NearCustomTokenRecord } from '@/infrastructure/chains/near/near-custom-tokens'
import { useSettingsStore } from '@/store/settings-store'
import { useWalletStore } from '@/store/wallet-store'
import { toast } from '@/store/toast-store'
import { ChainIcon } from '../../components/common/ChainIcon'
import { ChainSelector, type ChainSelectorOption } from '../../components/common/ChainSelector'
import { NetworkFilter } from '../../components/common/NetworkFilter'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { TokenIcon } from '../../components/tokens/TokenIcon'
import { Button } from '../../components/ui/button'
import { Switch } from '../../components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { userEvmAssetsClient } from '../../services/user-evm-assets-client'
import { nearCustomTokenClient } from '../../services/near-custom-token-client'
import { swapTokenCatalogClient } from '../../services/swap-token-catalog-client'
import {
  intentsAssetManagerClient,
  resolveManagedIntentsCatalog
} from '../../services/intents-asset-manager-client'
import {
  buildManagedTokenRows,
  filterManagedTokenRows,
  type ManagedTokenRow
} from '@/popup/services/managed-token-list'
import {
  buildAddTokenNetworks,
  getAddTokenReferencePresentation,
  getVerifiedTokenPresentation,
  isAddTokenReferenceSearch,
  type AddTokenCandidate
} from '@/popup/services/add-token-model'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'

type TokenRemoval =
  | { readonly kind: 'evm'; readonly asset: UserEvmAssetRecord }
  | { readonly kind: 'near'; readonly asset: NearCustomTokenRecord }

function nearTokenAssetId(token: NearCustomTokenRecord): string {
  return nearCustomTokenAssetId(token.chainId, token.contractId)
}

function withNearHiddenIds(
  evmIds: readonly string[],
  tokens: readonly NearCustomTokenRecord[]
): Set<string> {
  return new Set([...evmIds, ...tokens.filter(token => token.hidden).map(nearTokenAssetId)])
}

export function ManageTokens() {
  const settings = useSettingsStore(state => state.chainEndpointSettings)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const networks = useMemo(() => resolveEvmNetworkCatalog(DEFAULT_NETWORK, settings), [settings])
  const networkByChainId = useMemo(
    () =>
      new Map<string, (typeof networks)[number]>(
        networks.map(network => [network.chainId, network])
      ),
    [networks]
  )
  const chainByChainId = useMemo(() => {
    const customNetworks = networks.filter(network => network.source === 'custom')
    return new Map(
      createInitialProductChainRegistry(DEFAULT_NETWORK, customNetworks)
        .list()
        .map(chain => [chain.id as string, chain] as const)
    )
  }, [networks])
  const addTokenNetworks = useMemo(
    () => buildAddTokenNetworks(DEFAULT_NETWORK, networks, __ENABLED_CHAIN_FEATURE_FLAGS__),
    [networks]
  )
  const [assets, setAssets] = useState<readonly UserEvmAssetRecord[]>([])
  const [nearTokens, setNearTokens] = useState<readonly NearCustomTokenRecord[]>([])
  const [detectedAssets, setDetectedAssets] = useState<readonly DetectedEvmAssetRecord[]>([])
  const [catalogAssets, setCatalogAssets] = useState<readonly IntentsManagedAsset[]>([])
  const [hiddenAssetIds, setHiddenAssetIds] = useState<ReadonlySet<string>>(() => new Set())
  const [protocolAssetIds, setProtocolAssetIds] = useState<ReadonlySet<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [networkSelectorOpen, setNetworkSelectorOpen] = useState(false)
  const [chainId, setChainId] = useState<string>(
    addTokenNetworks.find(network => !network.disabled)?.chainId ?? ''
  )
  const [contractAddress, setContractAddress] = useState('')
  const [candidate, setCandidate] = useState<AddTokenCandidate | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<TokenRemoval | null>(null)
  const [removeInProgress, setRemoveInProgress] = useState(false)
  const [visibilityInProgress, setVisibilityInProgress] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNetworkIds, setSelectedNetworkIds] = useState<readonly string[]>([])
  const selectedNetwork = addTokenNetworks.find(
    network => network.chainId === chainId && !network.disabled
  )
  const isEvmNetwork = selectedNetwork?.family === 'evm'
  const isNearNetwork = selectedNetwork?.family === 'near'
  const referencePresentation = getAddTokenReferencePresentation(selectedNetwork)
  const verifiedToken = getVerifiedTokenPresentation(candidate)
  const addTokenNetworkOptions: readonly ChainSelectorOption[] = addTokenNetworks.map(network => ({
    id: network.chainId,
    name: network.displayName,
    icon: network.iconChain,
    disabled: network.disabled,
    ...(network.disabled ? { note: 'Coming soon' } : {})
  }))

  const managedAssets = useMemo(
    () =>
      buildManagedTokenRows({
        networks,
        userAssets: assets,
        detectedAssets,
        catalogAssets,
        protocolAssetIds
      }),
    [assets, catalogAssets, detectedAssets, networks, protocolAssetIds]
  )
  const nearRows = useMemo(
    () =>
      nearTokens.map(token => ({
        assetId: nearTokenAssetId(token),
        chainId: token.chainId,
        reference: token.contractId,
        blockchain: 'near',
        metadata: {
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals
        },
        source: 'custom' as const,
        registered: true
      })),
    [nearTokens]
  )
  const availableManagedAssets = useMemo(() => {
    const rows = managedAssets.filter(asset =>
      isSelectableChainFamily(
        chainByChainId.get(asset.chainId)?.family ??
          (networkByChainId.has(asset.chainId) ? 'evm' : ''),
        __ENABLED_CHAIN_FEATURE_FLAGS__
      )
    )
    if (!isSelectableChainFamily('near', __ENABLED_CHAIN_FEATURE_FLAGS__)) return rows
    const known = new Set(rows.map(asset => asset.assetId))
    return [...rows, ...nearRows.filter(row => !known.has(row.assetId))]
  }, [chainByChainId, managedAssets, nearRows, networkByChainId])

  const networkFilterOptions = useMemo(() => {
    const chainIds = new Set(availableManagedAssets.map(asset => asset.chainId))
    for (const network of addTokenNetworks) {
      if (!network.disabled) chainIds.add(network.chainId)
    }
    return Array.from(chainIds).map(assetChainId => {
      const chain = chainByChainId.get(assetChainId)
      const network = networkByChainId.get(assetChainId)
      return {
        id: assetChainId,
        family: chain?.family ?? network?.iconChain ?? assetChainId,
        displayName: chain?.displayName ?? network?.displayName ?? assetChainId
      }
    })
  }, [addTokenNetworks, availableManagedAssets, chainByChainId, networkByChainId])
  const selectedNetworkId =
    selectedNetworkIds.length === 1 &&
    networkFilterOptions.some(option => option.id === selectedNetworkIds[0])
      ? selectedNetworkIds[0]
      : null
  const filteredManagedAssets = useMemo(
    () => filterManagedTokenRows(availableManagedAssets, selectedNetworkId, searchQuery),
    [availableManagedAssets, searchQuery, selectedNetworkId]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [result, cachedTokens, savedNearTokens] = await Promise.all([
        userEvmAssetsClient.listManaged(),
        swapTokenCatalogClient.readCached(),
        walletId && accountId
          ? nearCustomTokenClient.list({ walletId, accountId })
          : Promise.resolve([])
      ])
      setAssets(result.userAssets)
      setNearTokens(savedNearTokens)
      setDetectedAssets(result.detectedAssets)
      setHiddenAssetIds(withNearHiddenIds(result.hiddenAssetIds, savedNearTokens))
      setProtocolAssetIds(new Set(result.protocolAssetIds))
      setCatalogAssets(resolveManagedIntentsCatalog(cachedTokens))
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [accountId, walletId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    void swapTokenCatalogClient
      .refresh()
      .then(async tokens => {
        if (cancelled) return
        setCatalogAssets(resolveManagedIntentsCatalog(tokens))
        if (!cancelled) {
          const result = await userEvmAssetsClient.listManaged()
          const savedNearTokens =
            walletId && accountId ? await nearCustomTokenClient.list({ walletId, accountId }) : []
          if (cancelled) return
          setAssets(result.userAssets)
          setNearTokens(savedNearTokens)
          setDetectedAssets(result.detectedAssets)
          setHiddenAssetIds(withNearHiddenIds(result.hiddenAssetIds, savedNearTokens))
          setProtocolAssetIds(new Set(result.protocolAssetIds))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [accountId, walletId])

  const resetAddForm = () => {
    setContractAddress('')
    setCandidate(null)
    setInspecting(false)
    setAdding(false)
    setChainId(addTokenNetworks.find(network => !network.disabled)?.chainId ?? '')
  }

  const openAddToken = () => {
    const network =
      addTokenNetworks.find(item => item.chainId === selectedNetworkId && !item.disabled) ??
      selectedNetwork
    setChainId(network?.chainId ?? '')
    setContractAddress(isAddTokenReferenceSearch(searchQuery, network) ? searchQuery.trim() : '')
    setCandidate(null)
    setAddOpen(true)
  }

  const setAddDialogOpen = (open: boolean) => {
    if (!open && (inspecting || adding)) return
    setAddOpen(open)
    if (!open) {
      setNetworkSelectorOpen(false)
      resetAddForm()
    }
  }

  const inspect = async () => {
    if (!selectedNetwork || !contractAddress.trim() || inspecting) return
    setInspecting(true)
    setCandidate(null)
    try {
      if (isEvmNetwork) {
        setCandidate({
          kind: 'evm',
          asset: await userEvmAssetsClient.inspect({
            chainId,
            contractAddress: contractAddress.trim()
          })
        })
      } else if (isNearNetwork) {
        setCandidate({
          kind: 'near',
          asset: await nearCustomTokenClient.inspect({
            chainId,
            contractId: contractAddress.trim()
          })
        })
      } else {
        let currentCatalog = catalogAssets
        let asset = findManagedIntentsAssetByReference(currentCatalog, chainId, contractAddress)
        if (!asset) {
          const refreshed = await swapTokenCatalogClient.refresh()
          currentCatalog = resolveManagedIntentsCatalog(refreshed)
          setCatalogAssets(currentCatalog)
          asset = findManagedIntentsAssetByReference(currentCatalog, chainId, contractAddress)
        }
        if (!asset || asset.management !== 'protocol') {
          throw new Error('This Token is not supported by the current Intents catalog.')
        }
        setCandidate({ kind: 'protocol', asset })
      }
    } catch (error) {
      toast.error(
        'Token Verification Failed',
        error instanceof Error ? error.message : 'Check the network and contract address.'
      )
    } finally {
      setInspecting(false)
    }
  }

  const add = async () => {
    if (!candidate || adding) return
    setAdding(true)
    try {
      if (candidate.kind === 'evm') {
        const added = await userEvmAssetsClient.add(candidate.asset)
        setAssets(previous => Object.freeze([...previous, added]))
      } else if (candidate.kind === 'near') {
        if (!walletId || !accountId) {
          throw new Error('Select an account before adding a Token.')
        }
        const added = await nearCustomTokenClient.add({
          walletId,
          accountId,
          token: candidate.asset
        })
        const assetId = nearTokenAssetId(added)
        setNearTokens(previous =>
          Object.freeze([...previous.filter(token => nearTokenAssetId(token) !== assetId), added])
        )
        setHiddenAssetIds(current => {
          const next = new Set(current)
          next.delete(assetId)
          return next
        })
      } else {
        await intentsAssetManagerClient.setVisible(candidate.asset, true)
        setProtocolAssetIds(current => new Set(current).add(candidate.asset.assetId))
        setHiddenAssetIds(current => {
          const next = new Set(current)
          next.delete(candidate.asset.assetId)
          return next
        })
      }
      setAddOpen(false)
      resetAddForm()
      toast.success('Token Added', `${verifiedToken?.symbol} is now visible in your wallet.`)
    } catch (error) {
      toast.error(
        'Token Could Not Be Added',
        error instanceof Error ? error.message : 'Review the Token and try again.'
      )
    } finally {
      setAdding(false)
    }
  }

  const remove = async () => {
    if (!removing || removeInProgress) return
    setRemoveInProgress(true)
    try {
      if (removing.kind === 'near') {
        if (!walletId || !accountId) {
          throw new Error('Select an account before removing a Token.')
        }
        const assetId = nearTokenAssetId(removing.asset)
        await nearCustomTokenClient.remove({
          walletId,
          accountId,
          chainId: removing.asset.chainId,
          contractId: removing.asset.contractId
        })
        setNearTokens(previous => previous.filter(token => nearTokenAssetId(token) !== assetId))
        setHiddenAssetIds(current => {
          const next = new Set(current)
          next.delete(assetId)
          return next
        })
        setRemoving(null)
        toast.success('Token Removed', `${removing.asset.symbol} was removed from your wallet.`)
        return
      }
      const asset = removing.asset
      await userEvmAssetsClient.remove(asset.assetId)
      setAssets(previous => previous.filter(item => item.assetId !== asset.assetId))
      setRemoving(null)
      toast.success('Token Removed', `${asset.metadata.symbol} was removed from your wallet.`)
    } catch (error) {
      toast.error(
        'Token Could Not Be Removed',
        error instanceof Error ? error.message : 'Try removing the Token again.'
      )
    } finally {
      setRemoveInProgress(false)
    }
  }

  const setHidden = async (assetId: string, hidden: boolean) => {
    if (visibilityInProgress) return
    setVisibilityInProgress(assetId)
    try {
      await userEvmAssetsClient.setHidden(assetId, hidden)
      setHiddenAssetIds(current => {
        const next = new Set(current)
        if (hidden) next.add(assetId)
        else next.delete(assetId)
        return next
      })
    } catch (error) {
      toast.error(
        'Token Visibility Could Not Be Changed',
        error instanceof Error ? error.message : 'Try again.'
      )
    } finally {
      setVisibilityInProgress(null)
    }
  }

  const setVisible = async (asset: ManagedTokenRow, visible: boolean) => {
    if (visibilityInProgress) return
    if (asset.source === 'custom' && asset.chainId.startsWith('near:')) {
      if (!walletId || !accountId) return
      setVisibilityInProgress(asset.assetId)
      try {
        const updated = await nearCustomTokenClient.setHidden({
          walletId,
          accountId,
          contractId: asset.reference,
          hidden: !visible
        })
        setNearTokens(previous =>
          previous.map(token => (nearTokenAssetId(token) === asset.assetId ? updated : token))
        )
        setHiddenAssetIds(current => {
          const next = new Set(current)
          if (updated.hidden) next.add(asset.assetId)
          else next.delete(asset.assetId)
          return next
        })
      } catch (error) {
        toast.error(
          'Token Visibility Could Not Be Changed',
          error instanceof Error ? error.message : 'Try again.'
        )
      } finally {
        setVisibilityInProgress(null)
      }
      return
    }
    if (asset.catalogAsset && (asset.catalogAsset.management === 'protocol' || !asset.registered)) {
      setVisibilityInProgress(asset.assetId)
      try {
        const enabled = await intentsAssetManagerClient.setVisible(asset.catalogAsset, visible)
        if (enabled) {
          setAssets(previous =>
            Object.freeze([...previous.filter(item => item.assetId !== asset.assetId), enabled])
          )
        }
        if (asset.catalogAsset.management === 'protocol') {
          setProtocolAssetIds(current => new Set(current).add(asset.assetId))
        }
        setHiddenAssetIds(current => {
          const next = new Set(current)
          if (visible) next.delete(asset.assetId)
          else next.add(asset.assetId)
          return next
        })
      } catch (error) {
        toast.error(
          'Token Could Not Be Enabled',
          error instanceof Error ? error.message : 'Try again.'
        )
      } finally {
        setVisibilityInProgress(null)
      }
      return
    }
    if (asset.registered) await setHidden(asset.assetId, !visible)
  }

  return (
    <div className="page-container">
      <PageHeader title="Manage Tokens" showBack />

      <div className="page-content space-y-3 pb-5">
        <Input
          aria-label="Search Tokens"
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          placeholder="Search Tokens by symbol or address"
          className="h-[46px] rounded-xl"
          startContent={<Icon icon="lucide:search" width={18} height={18} className="text-muted" />}
        />

        <NetworkFilter
          ariaLabelPrefix="Manage Tokens network"
          options={networkFilterOptions}
          selectedIds={selectedNetworkIds}
          onSelectionChange={setSelectedNetworkIds}
        />

        {loading && (
          <div className="space-y-2" aria-label="Loading custom Tokens" role="status">
            {[0, 1].map(item => (
              <div key={item} className="h-[72px] animate-pulse rounded-xl bg-card" />
            ))}
          </div>
        )}

        {!loading && loadError && (
          <InlineError message="Custom Tokens could not be loaded." onRetry={load} />
        )}

        {!loading && !loadError && filteredManagedAssets.length === 0 && (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 px-6 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-card">
              <Icon
                icon={availableManagedAssets.length === 0 ? 'lucide:coins' : 'lucide:search-x'}
                className="size-5 text-muted"
              />
            </div>
            <p className="text-sm font-medium">
              {selectedNetworkId && !searchQuery.trim()
                ? 'No Tokens on this network'
                : searchQuery.trim() || availableManagedAssets.length > 0
                  ? 'No matching Tokens'
                  : 'No Tokens found'}
            </p>
          </div>
        )}

        {!loading && !loadError && filteredManagedAssets.length > 0 && (
          <div className="space-y-2">
            {filteredManagedAssets.map(asset => {
              const network = networkByChainId.get(asset.chainId)
              const chain = chainByChainId.get(asset.chainId)
              const chainName = chain?.displayName ?? network?.displayName ?? asset.chainId
              const hidden = hiddenAssetIds.has(asset.assetId)
              const visible = asset.registered && !hidden
              return (
                <div
                  key={asset.assetId}
                  className="flex min-w-0 items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-3"
                >
                  <TokenIcon
                    assetId={asset.assetId}
                    symbol={asset.metadata.symbol}
                    icon={'iconUrl' in asset.metadata ? asset.metadata.iconUrl : undefined}
                    blockchain={asset.blockchain ?? network?.iconChain}
                    size="lg"
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{asset.metadata.symbol}</span>
                      {(asset.source === 'custom' || asset.source === 'detected') && (
                        <span className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-muted">
                          {asset.source === 'detected' ? 'Detected' : 'Custom'}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted">
                      {chainName}
                      {(asset.source === 'custom' || asset.source === 'detected') && (
                        <>
                          {' · '}
                          {formatSortAddress(asset.reference)}
                        </>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={visibilityInProgress === asset.assetId}
                    role="switch"
                    aria-checked={visible}
                    aria-label={`${visible ? 'Disable' : 'Enable'} ${asset.metadata.symbol} on ${chainName}`}
                    onClick={() => void setVisible(asset, !visible)}
                    className="flex shrink-0 items-center justify-center rounded-lg disabled:cursor-wait disabled:opacity-50"
                  >
                    {visibilityInProgress === asset.assetId ? (
                      <Icon
                        icon="lucide:loader-circle"
                        className="size-5 animate-spin text-primary"
                      />
                    ) : (
                      <Switch checked={visible} size="sm" />
                    )}
                  </button>
                  {asset.removableAsset && !asset.catalogAsset && (
                    <button
                      type="button"
                      aria-label={`Remove ${asset.metadata.symbol}`}
                      onClick={() => {
                        if (!asset.removableAsset) return
                        setRemoving({ kind: 'evm', asset: asset.removableAsset })
                      }}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Icon icon="lucide:trash-2" className="size-4" />
                    </button>
                  )}
                  {asset.source === 'custom' && asset.chainId.startsWith('near:') && (
                    <button
                      type="button"
                      aria-label={`Remove ${asset.metadata.symbol}`}
                      onClick={() => {
                        const token = nearTokens.find(
                          item => nearTokenAssetId(item) === asset.assetId
                        )
                        if (token) setRemoving({ kind: 'near', asset: token })
                      }}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Icon icon="lucide:trash-2" className="size-4" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="page-footer">
        <Button className="h-[45px] w-full" disabled={loading || loadError} onClick={openAddToken}>
          <Icon icon="lucide:plus" className="size-4" />
          Add Token
        </Button>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent position="bottom" className="max-h-[88vh] overflow-y-auto">
          <DialogHeader className="mb-6">
            <DialogTitle>Add Token</DialogTitle>
          </DialogHeader>

          <div className="space-y-1.5 text-xs text-muted">
            <span className="block">Network</span>
            <button
              type="button"
              aria-label="Token network"
              aria-haspopup="dialog"
              disabled={Boolean(candidate) || inspecting || adding}
              onClick={() => setNetworkSelectorOpen(true)}
              className="flex h-11 w-full items-center gap-2 rounded-xl border border-input bg-card px-3 text-left text-sm text-foreground outline-none transition-colors hover:border-foreground/20 focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {selectedNetwork && (
                <ChainIcon
                  chain={selectedNetwork.iconChain}
                  className="size-5 shrink-0 rounded-full bg-white"
                  showTooltip={false}
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {selectedNetwork?.displayName ?? 'Select network'}
              </span>
              <Icon icon="lucide:chevron-right" className="size-4 shrink-0 text-muted" />
            </button>
          </div>

          <label className="space-y-1.5 text-xs text-muted">
            {referencePresentation.label}
            <Input
              aria-label={referencePresentation.label}
              value={contractAddress}
              disabled={Boolean(candidate) || inspecting || adding}
              onChange={event => {
                setContractAddress(event.target.value)
                setCandidate(null)
              }}
              placeholder={referencePresentation.placeholder}
              className="h-11 rounded-xl font-mono text-xs text-foreground"
            />
          </label>

          {candidate && verifiedToken && (
            <div className="rounded-xl border border-primary/35 bg-primary/5 p-3">
              <div className="flex items-center gap-3">
                <TokenIcon
                  assetId={verifiedToken.assetId}
                  symbol={verifiedToken.symbol}
                  icon={verifiedToken.iconUrl}
                  blockchain={verifiedToken.blockchain}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{verifiedToken.name}</p>
                  <p className="text-xs text-muted">
                    {verifiedToken.symbol} · {verifiedToken.decimals} decimals
                  </p>
                </div>
                <Icon icon="lucide:circle-check" className="size-5 text-primary" />
              </div>
              <p className="mt-3 break-all font-mono text-[10px] leading-4 text-muted">
                {verifiedToken.reference}
              </p>
            </div>
          )}

          <div className="flex gap-2 rounded-xl border border-warning/25 bg-warning-surface px-3 py-2.5 text-xs leading-5 text-warning">
            <Icon icon="lucide:triangle-alert" className="mt-0.5 size-4 shrink-0" />
            <span>Anyone can create a Token. Only add tokens you trust.</span>
          </div>

          {candidate ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-11"
                disabled={adding}
                onClick={() => setCandidate(null)}
              >
                Edit
              </Button>
              <Button className="h-11" isLoading={adding} onClick={() => void add()}>
                Add Token
              </Button>
            </div>
          ) : (
            <Button
              className="h-11 w-full"
              isLoading={inspecting}
              disabled={!selectedNetwork || !contractAddress.trim()}
              onClick={() => void inspect()}
            >
              Verify Token
            </Button>
          )}
          <ChainSelector
            open={networkSelectorOpen}
            onOpenChange={setNetworkSelectorOpen}
            options={addTokenNetworkOptions}
            selectedId={chainId}
            onSelect={id => {
              setChainId(id)
              setCandidate(null)
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={removing !== null}
        onOpenChange={open => !open && !removeInProgress && setRemoving(null)}
      >
        <DialogContent position="bottom">
          <DialogHeader>
            <DialogTitle>
              Remove{' '}
              {removing?.kind === 'evm'
                ? removing.asset.metadata.symbol
                : removing?.kind === 'near'
                  ? removing.asset.symbol
                  : ''}
              ?
            </DialogTitle>
            <DialogDescription>
              This only hides the Token from Noir Wallet. It does not move or delete your balance.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="h-11"
              disabled={removeInProgress}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              isLoading={removeInProgress}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
