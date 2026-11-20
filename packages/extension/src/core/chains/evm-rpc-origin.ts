import { findBuiltinEvmNetworkConfig } from '@/config/networks'
import type { Network } from '@/types'
import { getEvmRpcEndpointOptions } from '@/infrastructure/chains/managed-rpc-endpoints'
import { parseChainId } from './registry'
import {
  findChainEndpointOverride,
  parseChainEndpointSettings,
  type ChainEndpointSettings
} from './chain-endpoint-settings'

export type EvmRpcOrigin = 'builtin' | 'user' | 'dapp'

const UNTRUSTED_RPC_CHECK_LABELS = new Set(['Simulation', 'Balance check', 'Authorization check'])

export function rpcUrlsMatch(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return false
  }
}

export function evmRpcOriginLabel(
  origin: EvmRpcOrigin
): 'Built-in' | 'Added by you' | 'Added by dApp' {
  switch (origin) {
    case 'builtin':
      return 'Built-in'
    case 'user':
      return 'Added by you'
    case 'dapp':
      return 'Added by dApp'
  }
}

/** Positive simulation and verification copy is withheld unless the node is built in. */
export function presentUntrustedRpcCheckValue(label: string, value: string): string {
  if (UNTRUSTED_RPC_CHECK_LABELS.has(label) && value !== 'UNKNOWN') return 'UNKNOWN'
  return value
}

/**
 * A cleared approval is confirmed only for a built-in node.
 * A missing origin is the existing wallet review, which still says Revoked.
 */
export function presentEvmRevocationLabel(origin: EvmRpcOrigin | undefined): 'Revoked' | 'UNKNOWN' {
  return origin === undefined || origin === 'builtin' ? 'Revoked' : 'UNKNOWN'
}

/**
 * Classify the endpoint this chain will actually query.
 * A built-in chain with no override uses the managed pool. A custom network
 * saved before `addedBy` existed cannot be told apart from a user-added one.
 */
export function resolveEvmRpcOrigin(
  networkMode: Network,
  settingsValue: unknown,
  chainId: string
): EvmRpcOrigin {
  const settings = parseChainEndpointSettings(settingsValue)
  const normalized = parseChainId(chainId).id
  const override = findChainEndpointOverride(settings, normalized)?.rpc
  if (findBuiltinEvmNetworkConfig(networkMode, normalized)) {
    if (!override) return 'builtin'
    const pooled = getEvmRpcEndpointOptions(networkMode, normalized).some(option =>
      rpcUrlsMatch(option.url, override.url)
    )
    return pooled ? 'builtin' : 'user'
  }
  return customNetworkOrigin(settings, normalized, override?.url)
}

function customNetworkOrigin(
  settings: ChainEndpointSettings,
  chainId: string,
  overrideUrl: string | undefined
): EvmRpcOrigin {
  const network = settings.customEvmNetworks.find(item => item.chainId === chainId)
  if (!network) return 'user'
  const activeUrl = overrideUrl ?? network.rpc.url
  if (network.addedBy === 'dapp' && rpcUrlsMatch(activeUrl, network.rpc.url)) return 'dapp'
  return 'user'
}
