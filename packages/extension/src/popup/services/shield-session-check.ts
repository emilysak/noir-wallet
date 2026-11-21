import type { ConfidentialBalanceErrorCode } from '@/popup/services/confidential-funding-client'
import type { TransferDomain } from '@/popup/services/private-balance-transfer'
import { isClusterTransferRoute } from '@/popup/services/shield-transfer'

export type ShieldSessionProbeStep = 'done' | 'authorize' | 'retry' | 'stop'

const BALANCE_PROBE_LIMIT = 3

/**
 * Cached Shield balances survive an extension reload. The session does not.
 * Freshness is accepted so a caller cannot treat it as a reason to skip.
 */
export function shouldProbeShieldSession(
  input: Readonly<{
    active: boolean
    enabled: boolean
    settled: boolean
    authorizeOnMount: boolean
    hasFreshBalances: boolean
    attempted: boolean
  }>
): boolean {
  const sessionMayBeMissing = input.hasFreshBalances || !input.hasFreshBalances
  return (
    sessionMayBeMissing &&
    input.active &&
    input.enabled &&
    input.settled &&
    input.authorizeOnMount &&
    !input.attempted
  )
}

/**
 * A direct deposit spends the public or private balance. Confirm signs in later.
 * Withdrawals and Cluster quotes read a Shield balance first.
 */
export function moveRequiresShieldBalance(
  input: Readonly<{
    from: TransferDomain
    to: TransferDomain
    method: 'cluster' | 'directly'
  }>
): boolean {
  return (
    input.from === 'shield' ||
    (input.method === 'cluster' && isClusterTransferRoute(input.from, input.to))
  )
}

/** A missing session is resolved by signing. Other failures stay on the page. */
export function nextShieldSessionProbe(
  input: Readonly<{
    ok: boolean
    authorize: boolean
    errorCode: ConfidentialBalanceErrorCode | null
    retries: number
  }>
): ShieldSessionProbeStep {
  if (input.ok) return 'done'
  if (!input.authorize && input.errorCode === 'authorization_required') return 'authorize'
  if (input.errorCode === 'balance_unavailable' && input.retries < BALANCE_PROBE_LIMIT) {
    return 'retry'
  }
  return 'stop'
}
