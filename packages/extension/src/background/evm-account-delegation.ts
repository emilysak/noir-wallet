import { parseAccountId } from '@/core/accounts/domain'
import {
  evmDelegationTargetsFromNetworks,
  readEvmDelegationForTargets,
  type EvmAccountDelegationResult,
  type EvmDelegationRpcNetwork
} from '@/core/chains/evm'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { AccountNetworksCatalog } from './account-networks'

export async function readEvmAccountDelegation(input: {
  readonly walletId: string
  readonly accountId: string
  readonly signal: AbortSignal
  readonly readCatalog: () => Promise<AccountNetworksCatalog | null>
  readonly networks: readonly EvmDelegationRpcNetwork[]
  readonly getCode: (chainId: string, address: string, signal: AbortSignal) => Promise<string>
}): Promise<EvmAccountDelegationResult> {
  if (input.signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
  let walletId
  let accountId
  try {
    walletId = parseKeyDomainId(input.walletId)
    accountId = parseAccountId(input.accountId)
  } catch {
    return unavailableDelegation()
  }

  let catalog: AccountNetworksCatalog | null
  try {
    catalog = await input.readCatalog()
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    return unavailableDelegation()
  }
  if (input.signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
  const account = catalog?.accounts.find(
    item => item.walletId === walletId && item.accountId === accountId
  )
  if (!account) return unavailableDelegation()

  const targets = evmDelegationTargetsFromNetworks(account.networks)
  if (new Set(targets.map(target => target.chainId)).size !== targets.length) {
    return unavailableDelegation()
  }
  // The private execution address stays on the network record and is not a target.
  const chains = await readEvmDelegationForTargets({
    signal: input.signal,
    targets,
    networks: input.networks,
    getCode: input.getCode
  })
  return Object.freeze({
    available: true,
    chains: Object.freeze(chains)
  })
}

function unavailableDelegation(): EvmAccountDelegationResult {
  return Object.freeze({ available: false, chains: Object.freeze([]) })
}
