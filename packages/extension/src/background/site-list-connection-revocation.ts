export interface ListedSiteConnection {
  readonly origin: string
  readonly host: string
}

export interface ListedSiteRevocationDeps {
  listConnections(): Promise<readonly ListedSiteConnection[]>
  isBlocked(origin: string): Promise<boolean>
  /** Returns false when the origin is no longer connected. */
  revoke(origin: string): Promise<boolean>
  notify(host: string): void
}

export const BLOCKED_SITE_DISCONNECTED_TITLE = 'Connected site removed'

const revoking = new Map<string, Promise<boolean>>()

export function resetListedSiteRevocationForTests(): void {
  revoking.clear()
}

export function blockedSiteDisconnectedMessage(host: string): string {
  const label = host.trim()
  if (!label) {
    return 'Noir Wallet disconnected a connected site because it is on the blocked site list.'
  }
  return `Noir Wallet disconnected ${label} because it is on the blocked site list.`
}

/**
 * Revokes saved connections that the caller reports as listed.
 * Concurrent calls for one origin share a single revoke and notification.
 */
export async function revokeListedSiteConnections(
  deps: ListedSiteRevocationDeps
): Promise<readonly string[]> {
  const connections = await deps.listConnections()
  const revoked: string[] = []
  await Promise.all(
    connections.map(async connection => {
      if (await revokeListedConnection(connection, deps)) revoked.push(connection.origin)
    })
  )
  return revoked
}

async function revokeListedConnection(
  connection: ListedSiteConnection,
  deps: ListedSiteRevocationDeps
): Promise<boolean> {
  const pending = revoking.get(connection.origin)
  if (pending) {
    await pending
    return false
  }
  if (!(await deps.isBlocked(connection.origin))) return false

  const raced = revoking.get(connection.origin)
  if (raced) {
    await raced
    return false
  }

  const task = revokeAndNotify(connection, deps)
  revoking.set(connection.origin, task)
  try {
    return await task
  } finally {
    if (revoking.get(connection.origin) === task) revoking.delete(connection.origin)
  }
}

async function revokeAndNotify(
  connection: ListedSiteConnection,
  deps: ListedSiteRevocationDeps
): Promise<boolean> {
  const revoked = await deps.revoke(connection.origin)
  if (!revoked) return false
  try {
    deps.notify(connection.host)
  } catch {
    // The connection stays revoked when the notification cannot be shown.
  }
  return true
}
