import type { KeyDomainSource } from '@/core/keyring/domain'

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
