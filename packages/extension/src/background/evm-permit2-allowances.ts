import { parseAccountId } from '@/core/accounts/domain'
import { evmDelegationTargetsFromNetworks } from '@/core/chains/evm'
import type { EvmRuntimeNetworkConfig } from '@/core/chains/evm-runtime-config'
import { getBundledEvmAssetDefinitions } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { DetectedEvmAssetRecord } from '@/core/chains/user-assets/detected-evm-asset'
import type { UserEvmAssetRecord } from '@/core/chains/user-assets/user-evm-asset'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { Network } from '@/types'
import { createConfiguredEvmRpcClient } from '@/infrastructure/chains/evm'
import { readEvmTokenAllowance } from '@/infrastructure/chains/evm/evm-token-allowance'
import type { EvmContractRpc } from '@/infrastructure/chains/evm/evm-rpc-client'
import { readPermit2InternalAllowance } from '@/infrastructure/chains/evm/evm-permit2-allowance'
import {
  collectPermit2Allowances,
  type Permit2AllowanceResult,
  type Permit2ChainReader,
  type Permit2KnownToken,
  type Permit2ScanStore
} from '@/infrastructure/chains/evm/evm-permit2-allowances'
import type { AccountNetworksCatalog } from './account-networks'

const STORAGE_KEY = 'noir.permit2AllowanceScan.v1'

export function knownPermit2Tokens(
  networkMode: Network,
  networks: readonly EvmRuntimeNetworkConfig[],
  userAssets: readonly UserEvmAssetRecord[],
  detectedAssets: readonly DetectedEvmAssetRecord[]
): readonly Permit2KnownToken[] {
  const tokens = new Map<string, Permit2KnownToken>()
  const add = (token: Permit2KnownToken) => {
    const key = `${token.chainId}:${token.contractAddress}`
    const current = tokens.get(key)
    if (!current || (token.trusted && !current.trusted)) tokens.set(key, token)
  }
  for (const asset of getBundledEvmAssetDefinitions(networkMode)) {
    if (asset.kind !== 'token' || asset.namespace !== 'erc20') continue
    add(
      trustedToken(asset.chainId, asset.reference, asset.metadata.symbol, asset.metadata.decimals)
    )
  }
  for (const network of networks) {
    if (!network.usdcContract) continue
    add(
      network.rpcOrigin === 'builtin'
        ? trustedToken(network.chainId, network.usdcContract, 'USDC', 6)
        : {
            chainId: network.chainId,
            contractAddress: network.usdcContract.toLowerCase(),
            symbol: null,
            decimals: null,
            trusted: false
          }
    )
  }
  for (const asset of [...userAssets, ...detectedAssets]) {
    add({
      chainId: asset.chainId,
      contractAddress: asset.contractAddress.toLowerCase(),
      symbol: null,
      decimals: null,
      trusted: false
    })
  }
  return Object.freeze([...tokens.values()])
}

export function chromePermit2ScanStore(): Permit2ScanStore {
  return {
    read: async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY],
    write: async value => {
      await chrome.storage.local.set({ [STORAGE_KEY]: value })
    }
  }
}

export async function readAccountPermit2Allowances(input: {
  readonly walletId: string
  readonly accountId: string
  readonly signal: AbortSignal
  readonly networks: readonly EvmRuntimeNetworkConfig[]
  readonly tokens: readonly Permit2KnownToken[]
  readonly readCatalog: () => Promise<AccountNetworksCatalog | null>
  readonly store?: Permit2ScanStore
}): Promise<Permit2AllowanceResult> {
  if (input.signal.aborted) throw abortError()
  let walletId
  let accountId
  try {
    walletId = parseKeyDomainId(input.walletId)
    accountId = parseAccountId(input.accountId)
  } catch {
    return unavailable()
  }
  let catalog: AccountNetworksCatalog | null
  try {
    catalog = await input.readCatalog()
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw abortError()
    }
    return unavailable()
  }
  const account = catalog?.accounts.find(
    item => item.walletId === walletId && item.accountId === accountId
  )
  if (!account) return unavailable()
  const targets = evmDelegationTargetsFromNetworks(account.networks)
  if (
    targets.length > 64 ||
    new Set(targets.map(target => target.chainId)).size !== targets.length
  ) {
    return unavailable()
  }
  const readable = targets.filter(
    (target): target is { readonly chainId: string; readonly address: string } =>
      target.address !== null
  )
  const networkById = new Map<string, EvmRuntimeNetworkConfig>(
    input.networks.map(network => [network.chainId, network])
  )
  const chains = readable.flatMap(target => {
    const network = networkById.get(target.chainId)
    if (!network) return []
    return [
      Object.freeze({
        chainId: target.chainId,
        rpcOrigin: network.rpcOrigin,
        address: target.address
      })
    ]
  })
  const byOwner = new Map<string, typeof chains>()
  for (const chain of chains) {
    const owner = chain.address.toLowerCase()
    const group = byOwner.get(owner) ?? []
    group.push(chain)
    byOwner.set(owner, group)
  }
  const results = []
  for (const [owner, group] of byOwner) {
    const read = await collectPermit2Allowances({
      signal: input.signal,
      networkMode: DEFAULT_NETWORK,
      owner,
      chains: group,
      tokens: input.tokens,
      store: input.store ?? chromePermit2ScanStore(),
      reader: chainId => {
        const network = networkById.get(chainId)
        if (!network) return null
        return readerFor(network)
      }
    })
    results.push(...read)
  }
  const byChain = new Map(results.map(chain => [chain.chainId, chain]))
  const ordered = targets.map(target => {
    const found = byChain.get(target.chainId)
    if (found) return found
    const network = networkById.get(target.chainId)
    return Object.freeze({
      chainId: target.chainId,
      rpcOrigin: network?.rpcOrigin ?? 'user',
      status: 'unavailable' as const,
      entries: Object.freeze([])
    })
  })
  return Object.freeze({
    available: true,
    chains: Object.freeze(ordered)
  })
}

function contractRpc(rpc: EvmContractRpc, signal: AbortSignal): EvmContractRpc {
  return {
    assertExpectedChain: () => rpc.assertExpectedChain(signal),
    getCode: address => rpc.getCode(address, signal),
    callContract: (address, data) => rpc.callContract(address, data, signal)
  }
}

function readerFor(network: EvmRuntimeNetworkConfig): Permit2ChainReader {
  const rpc = createConfiguredEvmRpcClient(DEFAULT_NETWORK, network)
  return {
    getBlockHeader: (block, signal) => rpc.getBlockHeader(block, signal),
    getCodeAt: (address, blockNumber, signal) => rpc.getCodeAt(address, blockNumber, signal),
    getLogs: (query, signal) => rpc.getLogs(query, signal),
    readErc20Allowance: (token, owner, spender, signal) =>
      readEvmTokenAllowance(contractRpc(rpc, signal), token, owner, spender),
    readPermit2Allowance: (owner, token, spender, signal) =>
      readPermit2InternalAllowance(contractRpc(rpc, signal), owner, token, spender)
  }
}

function trustedToken(
  chainId: string,
  contractAddress: string,
  symbol: string,
  decimals: number
): Permit2KnownToken {
  const trusted =
    Number.isInteger(decimals) &&
    decimals >= 0 &&
    decimals <= 255 &&
    symbol.length > 0 &&
    symbol.length <= 32
  return {
    chainId,
    contractAddress: contractAddress.toLowerCase(),
    symbol: trusted ? symbol : null,
    decimals: trusted ? decimals : null,
    trusted
  }
}

function unavailable(): Permit2AllowanceResult {
  return Object.freeze({ available: false, chains: Object.freeze([]) })
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}
