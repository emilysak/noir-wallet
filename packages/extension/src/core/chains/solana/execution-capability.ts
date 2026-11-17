import type { KeyDomainSource } from '@/core/keyring/domain'
import { parseSolanaPublicKey } from './identifiers'

type SolanaExecutionKeySource =
  | Readonly<{ kind: 'software' | 'hardware' }>
  | Pick<Extract<KeyDomainSource, { kind: 'private-key' }>, 'kind' | 'chainFamily'>

export function supportsSolanaPrivateExecution(
  source: SolanaExecutionKeySource | null | undefined
): boolean {
  return (
    source?.kind === 'software' ||
    (source?.kind === 'private-key' && source.chainFamily === 'solana')
  )
}

export function isSolanaPrivateExecutionAddress(
  value: string | null | undefined,
  mainAddress: string | null | undefined
): boolean {
  if (!value || !mainAddress || value === mainAddress) return false
  try {
    parseSolanaPublicKey(value)
    return true
  } catch {
    return false
  }
}
