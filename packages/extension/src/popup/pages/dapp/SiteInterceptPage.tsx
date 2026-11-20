import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

interface SiteInterceptView {
  readonly kind: 'hard' | 'list'
  readonly host: string | null
}

function parseIntercept(value: unknown, requestId: string): SiteInterceptView | null {
  if (!value || typeof value !== 'object' || !('result' in value)) return null
  const result = value.result
  if (!result || typeof result !== 'object') return null
  if (!('requestId' in result) || result.requestId !== requestId) return null
  if (!('kind' in result) || (result.kind !== 'hard' && result.kind !== 'list')) return null
  const host = 'host' in result ? result.host : null
  if (host !== null && (typeof host !== 'string' || host.length === 0)) return null
  if (result.kind === 'list' && typeof host !== 'string') return null
  return { kind: result.kind, host: typeof host === 'string' ? host : null }
}

export function SiteInterceptPage() {
  const [searchParams] = useSearchParams()
  const requestId = searchParams.get('requestId') ?? ''
  const [view, setView] = useState<SiteInterceptView | null>(null)
  const [typedHost, setTypedHost] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadVersion, setLoadVersion] = useState(0)

  useEffect(() => {
    let active = true
    if (!requestId) {
      setError('This site request is no longer available.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void chrome.runtime
      .sendMessage({ type: 'GET_SITE_INTERCEPT', requestId })
      .then((response: unknown) => {
        if (!active) return
        const parsed = parseIntercept(response, requestId)
        setView(parsed)
        setError(parsed ? null : 'This site request is no longer available.')
      })
      .catch(() => {
        if (active) setError('Could not load this site request.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [loadVersion, requestId])

  const close = async () => {
    if (busy) return
    setBusy(true)
    try {
      await chrome.runtime.sendMessage({
        type: 'RESOLVE_SITE_INTERCEPT',
        requestId,
        continued: false
      })
    } catch {
      // Closing the window still rejects the request.
    } finally {
      window.close()
    }
  }

  const continueRequest = async () => {
    if (!view || view.kind !== 'list' || busy || typedHost !== view.host) return
    setBusy(true)
    setError(null)
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'RESOLVE_SITE_INTERCEPT',
        requestId,
        continued: true,
        host: typedHost
      })
      if (
        !response ||
        typeof response !== 'object' ||
        !('result' in response) ||
        response.result !== true
      ) {
        throw new Error('Continue was not accepted')
      }
      window.close()
    } catch {
      setError('Type the host exactly.')
      setBusy(false)
    }
  }

  const hostMatches = view?.kind === 'list' && view.host !== null && typedHost === view.host

  return (
    <div className="page-container">
      <PageHeader title="Site blocked" />
      <div className="page-content min-h-0 space-y-4">
        {loading && (
          <p role="status" className="text-sm text-muted">
            Loading site details...
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {!loading && error === 'Could not load this site request.' && (
          <Button variant="outline" size="sm" onClick={() => setLoadVersion(value => value + 1)}>
            Retry
          </Button>
        )}
        {view?.kind === 'hard' && (
          <p className="text-sm text-foreground">
            Noir Wallet blocked this site. This request cannot continue.
          </p>
        )}
        {view?.kind === 'list' && (
          <>
            <p className="text-sm text-foreground">
              This site is on a block list. Continuing does not mark it as safe.
            </p>
            <p className="text-sm text-muted">Type the host exactly to continue.</p>
          </>
        )}
        {view?.host && <p className="break-all font-mono text-sm text-foreground">{view.host}</p>}
        {view?.kind === 'list' && view.host && (
          <form
            onSubmit={event => {
              event.preventDefault()
              void continueRequest()
            }}
          >
            <label htmlFor="site-intercept-host" className="mb-2 block text-sm text-muted">
              Host
            </label>
            <Input
              id="site-intercept-host"
              value={typedHost}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              onChange={event => setTypedHost(event.target.value)}
            />
          </form>
        )}
      </div>
      <div className="page-footer flex gap-2.5">
        <Button
          type="button"
          variant="outline"
          size="wallet"
          className="flex-1"
          disabled={busy}
          onClick={() => void close()}
        >
          Close
        </Button>
        {view?.kind === 'list' && (
          <Button
            type="button"
            variant="destructive"
            size="wallet"
            className="flex-1"
            disabled={!hostMatches || busy}
            onClick={() => void continueRequest()}
          >
            Continue
          </Button>
        )}
      </div>
    </div>
  )
}
