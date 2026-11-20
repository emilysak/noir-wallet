const EMPTY_RUNTIME_CODE = '0x'
const EVM_CHAIN_ID = /^eip155:(0|[1-9][0-9]{0,19})$/
const DELEGATION_DESIGNATOR = /^0xef0100([0-9a-f]{40})$/
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/
const MAXIMUM_DELEGATION_CHAINS = 64

export type EvmDelegationDesignator =
  | Readonly<{ readonly kind: 'absent' }>
  | Readonly<{ readonly kind: 'delegated'; readonly delegate: string }>
  | Readonly<{ readonly kind: 'other-code' }>

export type EvmDelegationChainStatus =
  | 'absent'
  | 'delegated'
  | 'other-code'
  | 'unavailable'
  | 'unverified'

export interface EvmAccountDelegationChain {
  readonly chainId: string
  readonly status: EvmDelegationChainStatus
  readonly delegate?: string
}

export interface EvmAccountDelegationResult {
  readonly available: boolean
  readonly chains: readonly EvmAccountDelegationChain[]
}

export type EvmDelegationSummary =
  | 'delegated'
  | 'has-code'
  | 'unavailable'
  | 'unverified'
  | 'not-delegated'

export interface EvmDelegationAccountNetwork {
  readonly chainId: string
  readonly addresses: readonly {
    readonly value: string
    readonly scheme: string
    readonly preferredForReceive: boolean
  }[]
  readonly privateExecutionAddress?: string
}

export interface EvmDelegationTarget {
  readonly chainId: string
  readonly address: string | null
}

export interface EvmDelegationRpcNetwork {
  readonly chainId: string
  readonly rpcOrigin: 'builtin' | 'user' | 'dapp'
}

/**
 * Classify an eth_getCode result for EIP-7702.
 * Only canonical empty code is undelegated. A designator is exactly
 * 0xef0100 followed by a 20-byte address.
 */
export function readEvmDelegationDesignator(code: string): EvmDelegationDesignator {
  if (typeof code !== 'string') return Object.freeze({ kind: 'other-code' })
  const normalized = code.toLowerCase()
  if (normalized === EMPTY_RUNTIME_CODE) return Object.freeze({ kind: 'absent' })
  const delegated = DELEGATION_DESIGNATOR.exec(normalized)
  if (!delegated) return Object.freeze({ kind: 'other-code' })
  return Object.freeze({ kind: 'delegated', delegate: `0x${delegated[1]}` })
}

export function evmDelegationTargetsFromNetworks(
  networks: readonly EvmDelegationAccountNetwork[]
): readonly EvmDelegationTarget[] {
  return Object.freeze(
    networks.flatMap(network => {
      if (!EVM_CHAIN_ID.test(network.chainId)) return []
      const addresses = network.addresses.filter(
        address => address.scheme === 'evm' && EVM_ADDRESS.test(address.value.toLowerCase())
      )
      const selected =
        addresses.find(address => address.preferredForReceive) ?? addresses[0] ?? null
      return [
        Object.freeze({
          chainId: network.chainId,
          address: selected ? selected.value.toLowerCase() : null
        })
      ]
    })
  )
}

export function summarizeEvmDelegation(
  chains: readonly EvmAccountDelegationChain[]
): EvmDelegationSummary | null {
  if (chains.length === 0) return null
  if (chains.some(isConfirmedDelegation)) return 'delegated'
  if (chains.some(chain => chain.status === 'other-code')) return 'has-code'
  if (chains.some(chain => chain.status === 'unavailable' || chain.status === 'delegated')) {
    return 'unavailable'
  }
  if (chains.some(chain => chain.status === 'unverified')) return 'unverified'
  return 'not-delegated'
}

export function evmDelegationSummaryLabel(summary: EvmDelegationSummary): string {
  switch (summary) {
    case 'delegated':
      return 'Delegated'
    case 'has-code':
      return 'Has code'
    case 'unavailable':
      return 'Unavailable'
    case 'unverified':
      return 'Unverified'
    case 'not-delegated':
      return 'Not delegated'
  }
}

export function parseEvmAccountDelegationResult(value: unknown): EvmAccountDelegationResult {
  const result = readRecord(value, 'EVM delegation result')
  assertExactKeys(result, ['available', 'chains'], 'EVM delegation result')
  if (typeof result.available !== 'boolean' || !Array.isArray(result.chains)) {
    throw new Error('Invalid EVM delegation result')
  }
  if (result.chains.length > MAXIMUM_DELEGATION_CHAINS) {
    throw new Error('Invalid EVM delegation result')
  }
  if (!result.available && result.chains.length !== 0) {
    throw new Error('Invalid EVM delegation result')
  }
  const chains = result.chains.map(chain => parseDelegationChain(chain))
  if (new Set(chains.map(chain => chain.chainId)).size !== chains.length) {
    throw new Error('Invalid EVM delegation result')
  }
  return Object.freeze({
    available: result.available,
    chains: Object.freeze(chains)
  })
}

export async function readEvmDelegationForTargets(input: {
  readonly signal: AbortSignal
  readonly targets: readonly EvmDelegationTarget[]
  readonly networks: readonly EvmDelegationRpcNetwork[]
  readonly getCode: (chainId: string, address: string, signal: AbortSignal) => Promise<string>
}): Promise<readonly EvmAccountDelegationChain[]> {
  throwIfAborted(input.signal)
  if (new Set(input.targets.map(target => target.chainId)).size !== input.targets.length) {
    throw new Error('Duplicate EVM delegation chain')
  }
  const networks = new Map(input.networks.map(network => [network.chainId, network]))
  return Promise.all(
    input.targets.map(async target => {
      throwIfAborted(input.signal)
      if (!target.address) return delegationChain(target.chainId, 'unavailable')
      const network = networks.get(target.chainId)
      // A non-builtin node cannot confirm that the account is undelegated.
      if (!network || network.rpcOrigin !== 'builtin') {
        return delegationChain(target.chainId, network ? 'unverified' : 'unavailable')
      }
      try {
        const code = await input.getCode(target.chainId, target.address, input.signal)
        throwIfAborted(input.signal)
        return delegationChainFromCode(target.chainId, code)
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) throw abortError()
        return delegationChain(target.chainId, 'unavailable')
      }
    })
  )
}

function delegationChainFromCode(chainId: string, code: string): EvmAccountDelegationChain {
  const designator = readEvmDelegationDesignator(code)
  if (designator.kind === 'delegated') {
    return delegationChain(chainId, 'delegated', designator.delegate)
  }
  return delegationChain(chainId, designator.kind)
}

function delegationChain(
  chainId: string,
  status: EvmDelegationChainStatus,
  delegate?: string
): EvmAccountDelegationChain {
  if (status === 'delegated') {
    if (!delegate || !EVM_ADDRESS.test(delegate)) {
      return Object.freeze({ chainId, status: 'unavailable' })
    }
    return Object.freeze({ chainId, status, delegate })
  }
  return Object.freeze({ chainId, status })
}

function isConfirmedDelegation(chain: EvmAccountDelegationChain): boolean {
  return (
    chain.status === 'delegated' && chain.delegate !== undefined && EVM_ADDRESS.test(chain.delegate)
  )
}

function parseDelegationChain(value: unknown): EvmAccountDelegationChain {
  const chain = readRecord(value, 'EVM delegation chain')
  if (typeof chain.chainId !== 'string' || !EVM_CHAIN_ID.test(chain.chainId)) {
    throw new Error('Invalid EVM delegation chain')
  }
  if (
    chain.status !== 'absent' &&
    chain.status !== 'delegated' &&
    chain.status !== 'other-code' &&
    chain.status !== 'unavailable' &&
    chain.status !== 'unverified'
  ) {
    throw new Error('Invalid EVM delegation chain')
  }
  if (chain.status === 'delegated') {
    assertExactKeys(chain, ['chainId', 'status', 'delegate'], 'EVM delegation chain')
    if (typeof chain.delegate !== 'string' || !EVM_ADDRESS.test(chain.delegate)) {
      throw new Error('Invalid EVM delegation chain')
    }
    return Object.freeze({
      chainId: chain.chainId,
      status: chain.status,
      delegate: chain.delegate
    })
  }
  assertExactKeys(chain, ['chainId', 'status'], 'EVM delegation chain')
  return Object.freeze({ chainId: chain.chainId, status: chain.status })
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
