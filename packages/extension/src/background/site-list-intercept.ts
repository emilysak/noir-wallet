import { UI_CONFIG } from '@/config/extension'
import { originCacheKey, type SiteListBlockKind } from '@/core/security/site-list'
import { isOwnExtensionRouteSender } from '@/lib/runtime-message-security'

const INTERCEPT_TIMEOUT_MS = 120_000
const INTERCEPT_ROUTE = '/site-intercept'

export interface SiteInterceptPrompt {
  readonly requestId: string
  readonly kind: SiteListBlockKind
  readonly host: string | null
}

interface PendingIntercept {
  readonly prompt: SiteInterceptPrompt
  windowId?: number
  tabId?: number
  finish(continued: boolean): void
}

const pending = new Map<string, PendingIntercept>()
const inflight = new Map<string, Promise<boolean>>()

/** Host shown for confirmation. Non-default ports stay in the value. */
export function siteInterceptHost(originKey: string): string | null {
  if (originCacheKey(originKey) !== originKey) return null
  try {
    const host = new URL(originKey).host
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

/** A list intercept continues only when the typed host matches the displayed host. */
export function acceptsSiteInterceptContinuation(
  kind: SiteListBlockKind,
  expectedHost: string | null,
  typedHost: unknown
): boolean {
  return kind === 'list' && typeof expectedHost === 'string' && typedHost === expectedHost
}

async function sourceWindowPosition(windowId: number | undefined): Promise<{
  left?: number
  top?: number
}> {
  if (typeof windowId !== 'number' || !Number.isInteger(windowId) || windowId < 0) return {}
  try {
    const source = await chrome.windows.get(windowId)
    if (source.id !== windowId || (source.type !== 'normal' && source.type !== 'popup')) return {}
    const { left, top, width } = source
    return {
      left:
        typeof left === 'number' &&
        Number.isFinite(left) &&
        typeof width === 'number' &&
        Number.isFinite(width) &&
        width > 0
          ? left + width - UI_CONFIG.DAPP_WINDOW.WIDTH - 20
          : undefined,
      top: typeof top === 'number' && Number.isFinite(top) ? top + 100 : undefined
    }
  } catch {
    return {}
  }
}

function openSiteIntercept(options: {
  readonly kind: SiteListBlockKind
  readonly originKey: string | null
  readonly sender: chrome.runtime.MessageSender
}): Promise<boolean> {
  const host = options.originKey === null ? null : siteInterceptHost(options.originKey)
  if (options.kind === 'list' && host === null) return Promise.resolve(false)
  if (typeof chrome.windows?.create !== 'function') return Promise.resolve(false)

  const requestId = crypto.randomUUID()
  const prompt: SiteInterceptPrompt = { requestId, kind: options.kind, host }
  const sourceTabId = options.sender.tab?.id
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (continued: boolean) => {
      if (settled) return
      settled = true
      pending.delete(requestId)
      clearTimeout(timer)
      chrome.windows.onRemoved.removeListener(onWindowRemoved)
      chrome.tabs.onRemoved.removeListener(onTabRemoved)
      chrome.tabs.onUpdated.removeListener(onTabUpdated)
      if (intercept.windowId !== undefined) {
        void chrome.windows.remove(intercept.windowId).catch(() => {})
      }
      resolve(options.kind === 'list' && continued)
    }
    const intercept: PendingIntercept = { prompt, finish }
    const onWindowRemoved = (windowId: number) => {
      if (windowId === intercept.windowId) finish(false)
    }
    const onTabRemoved = (tabId: number) => {
      if (tabId === sourceTabId) finish(false)
    }
    const onTabUpdated = (tabId: number, change: chrome.tabs.TabChangeInfo) => {
      if (tabId === sourceTabId && (change.status === 'loading' || change.url !== undefined)) {
        finish(false)
      }
    }
    const timer = setTimeout(() => finish(false), INTERCEPT_TIMEOUT_MS)
    pending.set(requestId, intercept)
    chrome.windows.onRemoved.addListener(onWindowRemoved)
    if (sourceTabId !== undefined) {
      chrome.tabs.onRemoved.addListener(onTabRemoved)
      chrome.tabs.onUpdated.addListener(onTabUpdated)
    }
    void sourceWindowPosition(options.sender.tab?.windowId)
      .then(position => {
        if (settled) return null
        return chrome.windows.create({
          url: chrome.runtime.getURL(`index.html#${INTERCEPT_ROUTE}?requestId=${requestId}`),
          type: 'popup',
          width: UI_CONFIG.DAPP_WINDOW.WIDTH,
          height: UI_CONFIG.DAPP_WINDOW.HEIGHT,
          ...position,
          focused: true
        })
      })
      .then(created => {
        if (!created) return
        intercept.windowId = created.id
        intercept.tabId = created.tabs?.[0]?.id
        if (settled || created.id === undefined || intercept.tabId === undefined) {
          if (created.id !== undefined) void chrome.windows.remove(created.id).catch(() => {})
          finish(false)
        }
      })
      .catch(() => finish(false))
  })
}

export function promptSiteListIntercept(options: {
  readonly kind: SiteListBlockKind
  readonly originKey: string | null
  readonly sender: chrome.runtime.MessageSender
}): Promise<boolean> {
  const shareKey = options.originKey === null ? null : `${options.kind}\n${options.originKey}`
  if (shareKey) {
    const existing = inflight.get(shareKey)
    if (existing) return existing
  }
  const pendingPrompt = openSiteIntercept(options).finally(() => {
    if (shareKey && inflight.get(shareKey) === pendingPrompt) inflight.delete(shareKey)
  })
  if (shareKey) inflight.set(shareKey, pendingPrompt)
  return pendingPrompt
}

export function handleSiteListInterceptMessage(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): boolean {
  if (message.type !== 'GET_SITE_INTERCEPT' && message.type !== 'RESOLVE_SITE_INTERCEPT') {
    return false
  }
  const requestId = typeof message.requestId === 'string' ? message.requestId : ''
  const intercept = pending.get(requestId)
  if (
    !intercept ||
    intercept.windowId === undefined ||
    intercept.tabId === undefined ||
    !isOwnExtensionRouteSender(sender, chrome.runtime.id, INTERCEPT_ROUTE, {
      windowId: intercept.windowId,
      tabId: intercept.tabId
    })
  ) {
    sendResponse({ error: 'This site request is no longer available.' })
    return true
  }
  if (message.type === 'GET_SITE_INTERCEPT') {
    sendResponse({ result: intercept.prompt })
    return true
  }
  if (message.continued === true) {
    if (
      !acceptsSiteInterceptContinuation(intercept.prompt.kind, intercept.prompt.host, message.host)
    ) {
      sendResponse({ error: 'Type the host exactly.' })
      return true
    }
    sendResponse({ result: true })
    intercept.finish(true)
    return true
  }
  sendResponse({ result: true })
  intercept.finish(false)
  return true
}
