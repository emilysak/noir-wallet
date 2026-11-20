import { shouldAutoConnectDApp } from '@/core/dapp/first-party-policy'

export type DAppMessageSigningMode = 'derived' | 'current' | 'legacy_index0'

export interface ReviewedDAppSigningIdentity {
  readonly signingMode: DAppMessageSigningMode
  readonly address: string
  readonly pubkey: string
}

const SIGNING_MODE_ERROR =
  'Invalid params: "signingMode" must be "current", "derived", or "legacy_index0"'

export function isDAppMessageSigningMode(value: unknown): value is DAppMessageSigningMode {
  return value === 'current' || value === 'derived' || value === 'legacy_index0'
}

/**
 * First-party origins may select a signing identity. Other sites stay on the
 * approved account, and an explicit non-current mode is rejected.
 */
export function resolveDAppMessageSigningMode(
  origin: string,
  options: unknown
): DAppMessageSigningMode {
  if (options === undefined) return 'current'
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid params: signing options must be an object')
  }
  const requested = Reflect.get(options, 'signingMode')
  if (requested === undefined) return 'current'
  if (!isDAppMessageSigningMode(requested)) {
    throw new Error(SIGNING_MODE_ERROR)
  }
  if (requested !== 'current' && !shouldAutoConnectDApp(origin)) {
    throw new Error('This site cannot request a signing mode. Use the current account.')
  }
  return requested
}

export function parseZcashSignMessageApproval(data: unknown): {
  readonly message: string
  readonly signingMode: DAppMessageSigningMode
  readonly address: string
  readonly pubkey: string
} | null {
  if (typeof data !== 'object' || data === null) return null
  const message = Reflect.get(data, 'message')
  const signingMode = Reflect.get(data, 'signingMode')
  const address = Reflect.get(data, 'address')
  const pubkey = Reflect.get(data, 'pubkey')
  if (typeof message !== 'string' || message.length === 0) return null
  if (!isDAppMessageSigningMode(signingMode)) return null
  if (typeof address !== 'string' || address.length === 0) return null
  if (typeof pubkey !== 'string' || pubkey.length === 0) return null
  return { message, signingMode, address, pubkey }
}

export function describeDAppMessageSigningMode(mode: DAppMessageSigningMode): string {
  switch (mode) {
    case 'current':
      return 'Current account'
    case 'derived':
      return 'Derived identity'
    case 'legacy_index0':
      return 'Legacy index 0'
  }
}

export function assertReviewedDAppSigningIdentity(
  reviewed: ReviewedDAppSigningIdentity,
  signed: { readonly signingMode?: string; readonly address?: string; readonly pubkey?: string }
): void {
  if (
    signed.signingMode !== reviewed.signingMode ||
    signed.address !== reviewed.address ||
    signed.pubkey !== reviewed.pubkey
  ) {
    throw new Error('The signing identity changed. Review the request again.')
  }
}

export async function signApprovedDAppMessage<T extends { pubkey?: string; address?: string }>(
  core: {
    signMessage(message: string, accountIndex?: number, addressIndex?: number): Promise<T>
  },
  message: string,
  approvedAccountIndex: number,
  mode: DAppMessageSigningMode | undefined,
  derivedAccountIndex: number
): Promise<T & { signingMode: DAppMessageSigningMode; originAddress?: string }> {
  if (mode === 'legacy_index0') {
    const signed = await core.signMessage(message, approvedAccountIndex, 0)
    return { ...signed, signingMode: 'legacy_index0' }
  }
  if (mode === 'derived') {
    const [derived, primary] = await Promise.all([
      core.signMessage(message, derivedAccountIndex),
      core.signMessage(message, approvedAccountIndex)
    ])
    return { ...derived, signingMode: 'derived', originAddress: primary.address }
  }
  const signed = await core.signMessage(message, approvedAccountIndex)
  return { ...signed, signingMode: 'current' }
}
