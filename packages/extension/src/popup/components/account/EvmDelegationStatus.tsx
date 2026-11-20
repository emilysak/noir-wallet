import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import {
  evmDelegationSummaryLabel,
  summarizeEvmDelegation,
  type EvmAccountDelegationChain,
  type EvmDelegationSummary
} from '@/core/chains/evm'
import { formatSortAddress } from '@/lib/format'
import { accountNetworkLabel } from '@/popup/services/account-network-presentation'
import { accountNetworksClient } from '@/popup/services/account-networks-client'
import { readEvmAccountDelegation } from '@/popup/services/evm-account-delegation-client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'

interface ReadyDelegation {
  readonly phase: 'ready'
  readonly summary: EvmDelegationSummary
  readonly chains: readonly EvmAccountDelegationChain[]
  readonly labels: Readonly<Record<string, string>>
}

type DelegationView =
  | Readonly<{ readonly phase: 'checking' }>
  | Readonly<{ readonly phase: 'hidden' }>
  | Readonly<{ readonly phase: 'unavailable' }>
  | ReadyDelegation

export function EvmDelegationStatus({
  enabled,
  walletId,
  accountId
}: {
  readonly enabled: boolean
  readonly walletId: string
  readonly accountId: string
}) {
  const requestKey = `${walletId}:${accountId}`
  const [state, setState] = useState<{ readonly key: string; readonly view: DelegationView }>({
    key: '',
    view: { phase: 'checking' }
  })
  const [openKey, setOpenKey] = useState<string | null>(null)
  const view = !enabled || state.key !== requestKey ? { phase: 'checking' as const } : state.view
  const open = openKey === requestKey && view.phase !== 'checking' && view.phase !== 'hidden'

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let current = true
    setOpenKey(null)
    void (async () => {
      try {
        const [catalog, delegation] = await Promise.all([
          accountNetworksClient.getCatalog().catch(() => null),
          readEvmAccountDelegation(walletId, accountId, controller.signal)
        ])
        if (!current || controller.signal.aborted) return
        if (!delegation.available) {
          setState({ key: requestKey, view: { phase: 'unavailable' } })
          return
        }
        if (delegation.chains.length === 0) {
          setState({ key: requestKey, view: { phase: 'hidden' } })
          return
        }
        const summary = summarizeEvmDelegation(delegation.chains)
        if (!summary) {
          setState({ key: requestKey, view: { phase: 'unavailable' } })
          return
        }
        const account = catalog?.accounts.find(
          item => item.walletId === walletId && item.accountId === accountId
        )
        const labels = Object.fromEntries(
          (account?.networks ?? [])
            .filter(network => network.chain.family === 'evm')
            .map(network => [network.chain.id, accountNetworkLabel(network)])
        )
        if (!current || controller.signal.aborted) return
        setState({
          key: requestKey,
          view: { phase: 'ready', summary, chains: delegation.chains, labels }
        })
      } catch (error) {
        if (
          !current ||
          controller.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          return
        }
        setState({ key: requestKey, view: { phase: 'unavailable' } })
      }
    })()
    return () => {
      current = false
      controller.abort()
    }
  }, [accountId, enabled, requestKey, walletId])

  if (!enabled || view.phase === 'hidden') return null

  const value =
    view.phase === 'checking'
      ? 'Checking'
      : view.phase === 'unavailable'
        ? 'Unavailable'
        : evmDelegationSummaryLabel(view.summary)
  const rowClassName =
    'flex h-[61px] w-full items-center gap-[17px] px-[27px] text-left transition-colors ' +
    (view.phase === 'checking' ? '' : 'cursor-pointer hover:bg-wallet-surface')

  const content = (
    <>
      <Icon icon="lucide:shield" width={20} height={20} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 text-lg leading-[23px] text-foreground">Delegation</span>
      <span className="shrink-0 text-sm text-muted">{value}</span>
      {view.phase === 'checking' ? null : (
        <Icon icon="lucide:chevron-right" width={16} height={16} className="shrink-0 text-muted" />
      )}
    </>
  )

  return (
    <>
      {view.phase === 'checking' ? (
        <div className={rowClassName}>{content}</div>
      ) : (
        <button type="button" className={rowClassName} onClick={() => setOpenKey(requestKey)}>
          {content}
        </button>
      )}
      <Dialog open={open} onOpenChange={next => setOpenKey(next ? requestKey : null)}>
        <DialogContent position="bottom" className="max-h-[70vh] gap-4 overflow-y-auto p-5">
          <DialogHeader>
            <DialogTitle>EIP-7702 delegation</DialogTitle>
          </DialogHeader>
          {view.phase === 'ready' ? (
            <ul className="flex flex-col">
              {view.chains.map(chain => {
                const status = chainStatusText(chain)
                return (
                  <li
                    key={chain.chainId}
                    className="flex items-center justify-between gap-3 border-t border-foreground/10 py-3 first:border-t-0"
                  >
                    <span className="min-w-0 truncate text-base">
                      {view.labels[chain.chainId] ?? chain.chainId}
                    </span>
                    <span className="shrink-0 text-sm text-muted" title={status.title}>
                      {status.text}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted">Delegation status is unavailable.</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function chainStatusText(chain: EvmAccountDelegationChain): {
  readonly text: string
  readonly title?: string
} {
  if (chain.status === 'delegated' && chain.delegate) {
    return {
      text: `Delegated to ${formatSortAddress(chain.delegate)}`,
      title: chain.delegate
    }
  }
  if (chain.status === 'absent') return { text: 'Not delegated' }
  if (chain.status === 'other-code') return { text: 'Has code' }
  if (chain.status === 'unverified') return { text: 'Unverified' }
  return { text: 'Unavailable' }
}
