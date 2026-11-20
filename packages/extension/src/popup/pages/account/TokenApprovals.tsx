import { resolveEvmChainIconAlias } from '@/config/icons'
import { parseChainId } from '@/core/chains/registry'
import {
  PERMIT2_CONTRACT,
  PERMIT2_TOKEN_REVOKE_EFFECT
} from '@/infrastructure/chains/evm/evm-contract-call-classification'
import { encodePermit2Lockdown } from '@/infrastructure/chains/evm/evm-permit2-allowance'
import type {
  Permit2AllowanceChain,
  Permit2AllowanceEntry,
  Permit2AllowanceResult
} from '@/infrastructure/chains/evm/evm-permit2-allowances'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { SigningSummaryReview } from '@/popup/components/signing/SigningSummaryReview'
import { accountNetworksClient } from '@/popup/services/account-networks-client'
import { accountNetworkLabel } from '@/popup/services/account-network-presentation'
import { readPermit2Allowances } from '@/popup/services/evm-permit2-allowances-client'
import { evmWalletClient, type EvmTransferReview } from '@/popup/services/evm-wallet-client'
import { openHardwareEvmSignTab } from '@/lib/hardware-tab'
import { useWalletStore } from '@/store/wallet-store'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/common/PageHeader'

const POLL_DELAY_MS = 1200

export function TokenApprovals() {
  const [searchParams] = useSearchParams()
  const walletId = searchParams.get('walletId') ?? ''
  const accountId = searchParams.get('accountId') ?? ''
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const wallets = useWalletStore(state => state.wallets)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const canChange = currentWalletId === walletId && currentAccountId === accountId
  const [result, setResult] = useState<Permit2AllowanceResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({})
  const [owner, setOwner] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<EvmTransferReview | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!walletId || !accountId) return
    const controller = new AbortController()
    let active = true
    let timer = 0
    const load = async () => {
      try {
        const next = await readPermit2Allowances(walletId, accountId, controller.signal)
        if (!active) return
        setFailed(false)
        setResult(next)
        if (next.chains.some(chain => chain.status === 'incomplete')) {
          timer = window.setTimeout(() => void load(), POLL_DELAY_MS)
        }
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
        setFailed(true)
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [walletId, accountId, refreshKey])

  useEffect(() => {
    if (!walletId || !accountId) return
    const controller = new AbortController()
    void accountNetworksClient
      .getCatalog()
      .then(catalog => {
        if (controller.signal.aborted) return
        const account = catalog?.accounts.find(
          item => item.walletId === walletId && item.accountId === accountId
        )
        const evm = (account?.networks ?? []).find(network => network.chain.family === 'evm')
        const address =
          evm?.addresses.find(item => item.preferredForReceive)?.value ?? evm?.addresses[0]?.value
        setLabels(
          Object.fromEntries(
            (account?.networks ?? [])
              .filter(network => network.chain.family === 'evm')
              .map(network => [network.chain.id, accountNetworkLabel(network)])
          )
        )
        setOwner(
          typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null
        )
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [walletId, accountId])

  const revoke = async (key: string, chainId: string, token: string) => {
    if (!owner) {
      setActionError('EVM address is unavailable.')
      return
    }
    setActionError(null)
    setNotice(null)
    setBusyKey(key)
    try {
      const selected = await evmWalletClient.selectErc20Revoke(
        chainId,
        token,
        PERMIT2_CONTRACT,
        owner
      )
      await prepare(key, chainId, token, selected.data)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not prepare this transaction')
      setBusyKey(null)
    }
  }

  const prepare = async (
    key: string,
    chainId: string,
    contractAddress: string,
    calldata: string
  ) => {
    setActionError(null)
    setNotice(null)
    setBusyKey(key)
    try {
      setPrepared(
        await evmWalletClient.prepareContractCall({
          chainId: parseChainId(chainId).id,
          contractAddress,
          valueRaw: '0',
          calldata
        })
      )
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not prepare this transaction')
    } finally {
      setBusyKey(null)
    }
  }

  const rejectPrepared = async () => {
    const transactionId = prepared?.graph.root.id
    setPrepared(null)
    if (transactionId) {
      await evmWalletClient.rejectTransfer(transactionId).catch(() => undefined)
    }
  }

  const approvePrepared = async () => {
    if (!prepared || submitting) return
    if (Date.now() >= prepared.review.expiresAt) {
      await rejectPrepared()
      setActionError('This review expired. Prepare it again.')
      return
    }
    setSubmitting(true)
    try {
      const submission = await evmWalletClient.approveTransfer(
        prepared.graph.root.id,
        prepared.review.payloadFingerprint.digestHex
      )
      if (submission.status === 'external-signature-required') {
        await openHardwareEvmSignTab(submission.transactionId)
        window.close()
        return
      }
      setPrepared(null)
      setNotice('Transaction submitted.')
      setRefreshKey(key => key + 1)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not submit this transaction')
    } finally {
      setSubmitting(false)
    }
  }

  if (prepared && prepared.review.summary.schema === 'evm.transaction.v1') {
    const chainId = prepared.review.summary.chainId
    const chain = result?.chains.find(item => item.chainId === chainId)
    const wallet = wallets.find(item => item.id === walletId)
    const account = wallet?.accounts.find(item => item.id === accountId)
    return (
      <SigningSummaryReview
        summary={prepared.review.summary}
        source={{ kind: 'wallet' }}
        securityJudgment="clear"
        chainName="EVM"
        iconChain={resolveEvmChainIconAlias(chainId)}
        networkName={labels[chainId] ?? chainId}
        accountName={
          account
            ? getAccountDisplayName(walletId, accountId, account.name, accountDisplayNames)
            : 'Account'
        }
        accountAddress={prepared.review.summary.fields.from}
        evmPresentation={{
          ...(chain ? { rpcOrigin: chain.rpcOrigin } : {}),
          tokenMetadata: trustedTokenMetadata(result)
        }}
        isSubmitting={submitting}
        onConfirm={() => void approvePrepared()}
        onReject={() => void rejectPrepared()}
      />
    )
  }

  return (
    <div className="page-container">
      <PageHeader title="Token approvals" showBack />
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {!canChange ? (
          <p className="mb-3 text-sm leading-5 text-muted">
            Switch to this account before changing its approvals.
          </p>
        ) : null}
        {notice ? <p className="mb-3 text-sm leading-5 text-foreground">{notice}</p> : null}
        {actionError ? (
          <p className="mb-3 text-sm leading-5 text-destructive">{actionError}</p>
        ) : null}
        {failed || !walletId || !accountId ? (
          <p className="text-sm leading-5 text-muted">Token approvals are unavailable.</p>
        ) : result === null ? (
          <p className="text-sm leading-5 text-muted">Loading token approvals</p>
        ) : !result.available ? (
          <p className="text-sm leading-5 text-muted">Token approvals are unavailable.</p>
        ) : result.chains.length === 0 ? (
          <p className="text-sm leading-5 text-muted">This account has no EVM address.</p>
        ) : (
          result.chains.map(chain => (
            <ChainSection
              key={chain.chainId}
              chain={chain}
              label={labels[chain.chainId] ?? chain.chainId}
              canChange={canChange}
              busyKey={busyKey}
              onRevoke={entry =>
                void revoke(entryKey(chain.chainId, entry), chain.chainId, entry.token)
              }
              onLockdown={entry => {
                if (entry.kind !== 'internal') return
                void prepare(
                  entryKey(chain.chainId, entry),
                  chain.chainId,
                  PERMIT2_CONTRACT,
                  encodePermit2Lockdown([{ token: entry.token, spender: entry.spender }])
                )
              }}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ChainSection({
  chain,
  label,
  canChange,
  busyKey,
  onRevoke,
  onLockdown
}: {
  readonly chain: Permit2AllowanceChain
  readonly label: string
  readonly canChange: boolean
  readonly busyKey: string | null
  readonly onRevoke: (entry: Permit2AllowanceEntry) => void
  readonly onLockdown: (entry: Permit2AllowanceEntry) => void
}) {
  return (
    <section className="mb-4">
      <h2 className="mb-2 text-sm font-medium text-foreground">{label}</h2>
      {chain.rpcOrigin !== 'builtin' ? (
        <p className="mb-2 text-xs leading-4 text-muted">Unverified node</p>
      ) : null}
      <ChainStatus chain={chain} />
      {chain.entries.map(entry => {
        const key = entryKey(chain.chainId, entry)
        return (
          <article key={key} className="mb-2 rounded-lg border border-border p-3">
            <p className="text-sm text-foreground">
              {entry.kind === 'token-permit2' ? 'Token → Permit2' : 'Permit2 allowance'}
            </p>
            <p className="mt-1 break-all text-xs leading-4 text-muted">
              {entry.symbol ?? formatSortAddress(entry.token)}
            </p>
            {entry.kind === 'internal' ? (
              <p className="mt-1 break-all text-xs leading-4 text-muted">
                Spender {formatSortAddress(entry.spender)}
              </p>
            ) : null}
            <p className="mt-1 text-sm text-foreground">{formatAllowanceAmount(entry)}</p>
            {entry.kind === 'internal' ? (
              <p className="mt-1 text-xs leading-4 text-muted">
                {entry.expired ? 'Expired' : `Expires ${formatExpiration(entry.expirationRaw)}`}
              </p>
            ) : (
              <p className="mt-2 text-xs leading-4 text-muted">{PERMIT2_TOKEN_REVOKE_EFFECT}</p>
            )}
            <button
              type="button"
              className="mt-3 h-8 rounded-lg border border-border px-3 text-sm text-foreground enabled:hover:bg-wallet-surface disabled:opacity-50"
              disabled={!canChange || busyKey !== null}
              onClick={() => (entry.kind === 'internal' ? onLockdown(entry) : onRevoke(entry))}
            >
              {busyKey === key ? 'Preparing' : entry.kind === 'internal' ? 'Lock down' : 'Revoke'}
            </button>
          </article>
        )
      })}
    </section>
  )
}

function ChainStatus({ chain }: { readonly chain: Permit2AllowanceChain }) {
  if (chain.status === 'unavailable') {
    return <p className="text-sm leading-5 text-muted">Approvals on this chain are unavailable.</p>
  }
  if (chain.status === 'absent') {
    return <p className="text-sm leading-5 text-muted">Permit2 is not deployed on this chain.</p>
  }
  if (chain.status === 'incomplete' && chain.entries.length === 0) {
    return <p className="text-sm leading-5 text-muted">Loading older approvals.</p>
  }
  if (chain.status === 'incomplete') {
    return <p className="mb-2 text-xs leading-4 text-muted">Still loading older approvals.</p>
  }
  if (chain.entries.length === 0) {
    return <p className="text-sm leading-5 text-muted">No token approvals found.</p>
  }
  return null
}

function formatAllowanceAmount(entry: Permit2AllowanceEntry): string {
  if (entry.unlimited) return 'Unlimited'
  if (entry.symbol && entry.decimals !== null) {
    return `${formatBaseUnitDecimalAmount(entry.amountRaw, entry.decimals)} ${entry.symbol}`
  }
  return entry.amountRaw
}

function formatExpiration(raw: string): string {
  const seconds = Number(raw)
  if (!Number.isSafeInteger(seconds)) return raw
  return new Date(seconds * 1000).toLocaleString()
}

function entryKey(chainId: string, entry: Permit2AllowanceEntry): string {
  return entry.kind === 'internal'
    ? `${chainId}:internal:${entry.token}:${entry.spender}`
    : `${chainId}:token:${entry.token}`
}

function trustedTokenMetadata(result: Permit2AllowanceResult | null) {
  return (result?.chains ?? []).flatMap(chain =>
    chain.entries.flatMap(entry =>
      entry.symbol && entry.decimals !== null
        ? [
            {
              contractAddress: entry.token,
              symbol: entry.symbol,
              decimals: entry.decimals,
              verification: 'trusted' as const
            }
          ]
        : []
    )
  )
}
