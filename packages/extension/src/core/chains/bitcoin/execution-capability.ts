import type { KeyDomainSource } from '@/core/keyring/domain'

const BITCOIN_PEA_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN_PEA_TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'

type BitcoinExecutionKeySource =
  | Readonly<{ kind: 'software' | 'hardware' }>
  | Pick<
      Extract<KeyDomainSource, { kind: 'private-key' }>,
      'kind' | 'chainFamily' | 'bitcoinNetwork'
    >

/**
 * Software vaults and imported Bitcoin keys can derive one P2WPKH PEA.
 * Hardware signers cannot. Imported keys are valid only at account index 0.
 */
export function supportsBitcoinPrivateExecution(
  source: BitcoinExecutionKeySource | null | undefined,
  accountIndex?: number,
  chainId?: string
): boolean {
  if (source?.kind === 'software') return true
  if (source?.kind !== 'private-key' || source.chainFamily !== 'bip122') return false
  if (accountIndex !== undefined && accountIndex !== 0) return false
  if (chainId === undefined) return true
  const network =
    chainId === BITCOIN_PEA_MAINNET ? 'mainnet' : chainId === BITCOIN_PEA_TESTNET ? 'testnet' : null
  return network !== null && source.bitcoinNetwork === network
}
