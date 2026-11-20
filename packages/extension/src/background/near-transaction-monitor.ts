import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import { getNearNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveNearRpcEndpointOptions } from '@/infrastructure/chains/managed-rpc-endpoints'
import {
  ChromeSessionNearFullAccessKeyRemovalStore,
  createConfiguredNearRpcClient,
  createNearRpcClient,
  NearTransactionMonitor,
  pollNearFullAccessKeyRemovals,
  selectNearCrossCheckRpcUrl,
  type NearFullAccessKeyRemovalPollResult,
  type NearPendingBroadcastRecoveryResult,
  type NearTransactionMonitorResult
} from '@/infrastructure/chains/near'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'

export const NEAR_TRANSACTION_MONITOR_ALARM = 'near-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5

export interface BackgroundNearTransactionMonitorController {
  readonly recoverSignedTransfers: () => Promise<NearPendingBroadcastRecoveryResult>
}

export class BackgroundNearTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly removals = new ChromeSessionNearFullAccessKeyRemovalStore()
  private readonly monitor: NearTransactionMonitor

  constructor(private readonly controller: BackgroundNearTransactionMonitorController) {
    const network = getNearNetworkConfig(DEFAULT_NETWORK)
    this.monitor = new NearTransactionMonitor({
      repository: new IndexedDbTransactionRepository(),
      chainId: network.chainId,
      rpc: createConfiguredNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
    })
  }

  async init(): Promise<NearTransactionMonitorResult> {
    return this.poll()
  }

  async handleAlarm(): Promise<NearTransactionMonitorResult> {
    return this.poll()
  }

  private async loadPersistedScopes(): Promise<readonly TransactionAccountScope[]> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze([])
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }
    return listKeySourceAllowedAccountScopes({
      keyDomains: snapshot.keyDomains,
      chainAccounts: snapshot.chainAccounts,
      chainId: getNearNetworkConfig(DEFAULT_NETWORK).chainId,
      family: 'near'
    })
  }

  private async pollFullAccessKeyRemovals(): Promise<NearFullAccessKeyRemovalPollResult> {
    const network = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK)
    const records = await this.removals.listRemovals(network.chainId)
    const override = findChainEndpointOverride(
      getActiveChainEndpointSettings(),
      network.chainId
    )?.rpc
    const customEndpoint = override?.protocol === 'near-json-rpc'
    const secondaryUrl = selectNearCrossCheckRpcUrl({
      primaryRpcUrl: network.rpcUrl,
      endpointUrls: customEndpoint
        ? []
        : resolveNearRpcEndpointOptions(network.network).map(endpoint => endpoint.url),
      customEndpoint
    })
    const outcome = await pollNearFullAccessKeyRemovals({
      records,
      now: Date.now(),
      primary: createNearRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl }),
      secondary:
        secondaryUrl === null
          ? null
          : createNearRpcClient({ chainId: network.chainId, rpcUrl: secondaryUrl })
    })
    for (const record of [...outcome.verified, ...outcome.unconfirmed]) {
      await this.removals.deleteRemoval(record)
    }
    return outcome
  }

  private async poll(): Promise<NearTransactionMonitorResult> {
    const recovery = await this.controller.recoverSignedTransfers()
    const result = await this.monitor.poll(await this.loadPersistedScopes())
    let removal: NearFullAccessKeyRemovalPollResult = {
      verified: [],
      unconfirmed: [],
      pending: 0,
      errors: 0
    }
    try {
      removal = await this.pollFullAccessKeyRemovals()
    } catch {
      removal = { verified: [], unconfirmed: [], pending: 1, errors: 1 }
    }
    const errors = recovery.errors + result.errors + removal.errors
    if (errors > 0) console.warn(`[NEAR Transaction Monitor] ${errors} observation(s) failed`)
    if (recovery.pending > 0 || result.checked > 0 || removal.pending > 0 || errors > 0) {
      await chrome.alarms.create(NEAR_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes: POLL_DELAY_MINUTES
      })
    } else {
      await chrome.alarms.clear(NEAR_TRANSACTION_MONITOR_ALARM)
    }
    return Object.freeze({
      checked: result.checked + recovery.attempted,
      applied: result.applied + recovery.broadcast + removal.verified.length,
      unchanged: result.unchanged + recovery.pending + removal.pending + removal.unconfirmed.length,
      errors
    })
  }
}
