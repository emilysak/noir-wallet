const OFFICIAL_AUTO_CONNECT_ORIGINS = ['https://app.zknoir.com'] as const
const PREVIEW_AUTO_CONNECT_ORIGINS = [
  'https://app.zknoir.com',
  'https://noirdevelop.refburrow.top'
] as const

function allowsStagingAutoConnect(buildChannel: string): boolean {
  return buildChannel === 'development' || buildChannel === 'beta'
}

export function shouldAutoConnectDAppForBuild(origin: string, buildChannel: string): boolean {
  const origins: readonly string[] = allowsStagingAutoConnect(buildChannel)
    ? PREVIEW_AUTO_CONNECT_ORIGINS
    : OFFICIAL_AUTO_CONNECT_ORIGINS
  return origins.includes(origin)
}

// Keep this condition aligned with allowsStagingAutoConnect. Compare the injected
// channel inline so production compilation drops the staging origin.
const AUTO_CONNECT_DAPP_ORIGINS: ReadonlySet<string> = new Set(
  (typeof __BUILD_CHANNEL__ === 'string' ? __BUILD_CHANNEL__ : 'development') === 'development' ||
    (typeof __BUILD_CHANNEL__ === 'string' ? __BUILD_CHANNEL__ : 'development') === 'beta'
    ? PREVIEW_AUTO_CONNECT_ORIGINS
    : OFFICIAL_AUTO_CONNECT_ORIGINS
)

export function shouldAutoConnectDApp(origin: string): boolean {
  return AUTO_CONNECT_DAPP_ORIGINS.has(origin)
}

export function getDAppSessionScopeLimit(origin?: string): number {
  // Official apps include the bundled catalog and up to 32 custom EVM networks.
  return origin !== undefined && shouldAutoConnectDApp(origin) ? 64 : 16
}
