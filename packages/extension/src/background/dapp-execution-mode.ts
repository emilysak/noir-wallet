import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { supportsSolanaPrivateExecution } from '@/core/chains/solana'
import { resolveSolanaRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import { getEvmNetworkConfig } from '@/config/networks'
import {
  DAppExecutionModeCoordinator,
  DAppExecutionModeRequestGate,
  type DAppExecutionModeRepository,
  type PersistedDAppExecutionModes
} from '@/core/dapp/dapp-execution-mode'
import { loadActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { loadActiveSolanaTransferContext } from './solana-transfer'

const DAPP_EXECUTION_MODE_STORAGE_KEY = 'dapp_execution_modes_v1'

export class ChromeDAppExecutionModeRepository implements DAppExecutionModeRepository {
  async read(): Promise<unknown> {
    const stored = await chrome.storage.local.get(DAPP_EXECUTION_MODE_STORAGE_KEY)
    return stored[DAPP_EXECUTION_MODE_STORAGE_KEY]
  }

  async write(value: PersistedDAppExecutionModes): Promise<void> {
    await chrome.storage.local.set({ [DAPP_EXECUTION_MODE_STORAGE_KEY]: value })
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove(DAPP_EXECUTION_MODE_STORAGE_KEY)
  }
}

const storageRepository = new IndexedDbStorageV2Repository()

export const dappExecutionModeCoordinator = new DAppExecutionModeCoordinator(
  new ChromeDAppExecutionModeRepository(),
  {
    isAvailable: async scope => {
      if (scope.network !== DEFAULT_NETWORK) return false
      const evmContext = await loadActiveEvmPortfolioContext(
        storageRepository,
        getEvmNetworkConfig(DEFAULT_NETWORK).chainId
      )
      if (
        evmContext !== null &&
        supportsEvmPrivateExecution(evmContext.keyDomainSource) &&
        evmContext.chainAccount.scope.keyDomainId === scope.keyDomainId &&
        evmContext.chainAccount.scope.accountId === scope.accountId
      ) {
        return true
      }
      const solanaContext = await loadActiveSolanaTransferContext(
        storageRepository,
        resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK).chainId
      )
      return (
        solanaContext !== null &&
        supportsSolanaPrivateExecution(solanaContext.keyDomainSource) &&
        solanaContext.chainAccount.scope.keyDomainId === scope.keyDomainId &&
        solanaContext.chainAccount.scope.accountId === scope.accountId
      )
    }
  }
)

export const dappExecutionModeRequestGate = new DAppExecutionModeRequestGate()
