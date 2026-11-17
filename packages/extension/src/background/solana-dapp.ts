import { trackEvent } from '@/background/analytics/reporter'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveSolanaRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { dappManager } from '@/core/dapp/dapp-manager'
import { PrivateExecutionUnavailableError } from '@/core/dapp/dapp-execution-mode'
import { supportsSolanaPrivateExecution } from '@/core/chains/solana'
import { NativeTransferProviderError } from '@/core/dapp/native-transfer-provider'
import {
  createConfiguredSolanaRpcClient,
  parseSolanaPublicKey
} from '@/infrastructure/chains/solana'
import { SolanaMultichainSigningClient } from '@/infrastructure/keyring/multichain/solana-signing-client'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'

import { accountContextTransition } from './account-context-transition'
import { credentialSession } from './credential-session'
import { dappExecutionModeCoordinator } from './dapp-execution-mode'
import { solanaLedgerSigningBridge } from './ledger-signing-bridge'
import { dappHandler } from './dapp-handler'
import { BackgroundNativeTransferDAppHandler } from './native-transfer-dapp-handler'
import { BackgroundSolanaDAppHandler } from './solana-dapp-handler'
import { loadActiveSolanaTransferContext } from './solana-transfer'
import type { ActiveSolanaTransferContext } from './solana-transfer-controller'
import {
  filterEnabledDAppContext,
  isDAppNetworkEnabled,
  listDAppChainAccounts
} from './dapp-chain-account-catalog'

async function resolveSolanaExecutionIdentity(
  context: ActiveSolanaTransferContext,
  signer: SolanaMultichainSigningClient
): Promise<{ readonly mode: 'main' | 'private'; readonly address: string }> {
  const mainAddress = parseSolanaPublicKey(context.chainAccount.identity.value)
  const state = await dappExecutionModeCoordinator.read({
    network: DEFAULT_NETWORK,
    keyDomainId: context.chainAccount.scope.keyDomainId,
    accountId: context.chainAccount.scope.accountId
  })
  if (state.mode === 'main') return Object.freeze({ mode: 'main', address: mainAddress })
  if (!supportsSolanaPrivateExecution(context.keyDomainSource)) {
    throw new PrivateExecutionUnavailableError()
  }
  const pea = await signer.deriveSolanaPea(
    context.chainAccount.scope.keyDomainId,
    context.accountIndex
  )
  if (pea.address === mainAddress) throw new PrivateExecutionUnavailableError()
  return Object.freeze({ mode: 'private', address: pea.address })
}

export function createBackgroundSolanaDAppHandler(
  endpointSettings?: ChainEndpointSettings
): BackgroundSolanaDAppHandler {
  const network = resolveSolanaRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const storageRepository = new IndexedDbStorageV2Repository()
  const rpc = createConfiguredSolanaRpcClient({ chainId: network.chainId, rpcUrl: network.rpcUrl })
  const signer = new SolanaMultichainSigningClient({
    credentials: credentialSession,
    rpc,
    ledger: solanaLedgerSigningBridge
  })
  const native = new BackgroundNativeTransferDAppHandler({
    analytics: trackEvent,
    providerId: 'solana',
    familyName: 'Solana',
    chainId: network.chainId,
    chainName: network.displayName,
    iconChain: 'solana',
    connectApprovalAction: 'solanaConnect',
    manager: dappManager,
    approval: dappHandler,
    loadActiveContext: async () =>
      filterEnabledDAppContext(
        await loadActiveSolanaTransferContext(storageRepository, network.chainId),
        'solana'
      ),
    listAccounts: () =>
      listDAppChainAccounts({
        repository: storageRepository,
        chainId: network.chainId,
        family: 'solana',
        isNetworkEnabled: isDAppNetworkEnabled,
        resolveAddress: ({ chainAccount }) =>
          chainAccount.identity.kind === 'account-identifier'
            ? parseSolanaPublicKey(chainAccount.identity.value)
            : null
      }),
    hasUnlockSession: () => credentialSession.hasUnlockSession(),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    parseAddress: parseSolanaPublicKey,
    resolveExecutionIdentity: ({ context }) => resolveSolanaExecutionIdentity(context, signer)
  })
  return new BackgroundSolanaDAppHandler({
    analytics: trackEvent,
    native,
    network,
    signer,
    rpc,
    requestApproval: (origin, action, data) =>
      dappHandler.requestExternalApproval(origin, action, data),
    runActiveOperation: operation => accountContextTransition.runActiveOperation(operation),
    loadAuthorizedAccount: async origin => {
      if (!(await credentialSession.hasUnlockSession())) {
        throw new NativeTransferProviderError(4100, 'Unlock Noir Wallet before signing.')
      }
      const context = await filterEnabledDAppContext(
        await loadActiveSolanaTransferContext(storageRepository, network.chainId),
        'solana'
      )
      if (!context || context.chainAccount.identity.kind !== 'account-identifier') {
        throw new NativeTransferProviderError(4100, 'The active wallet has no Solana account.')
      }
      const reference = Object.freeze({
        walletId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      })
      const authorization = await dappManager.getChainAuthorization(origin, network.chainId)
      if (
        !authorization?.accounts.some(
          account =>
            account.walletId === reference.walletId && account.accountId === reference.accountId
        )
      ) {
        throw new NativeTransferProviderError(4100, 'This site is not authorized for Solana.')
      }
      const identity = await resolveSolanaExecutionIdentity(context, signer)
      return Object.freeze({
        context,
        reference,
        address: identity.address,
        executionMode: identity.mode
      })
    }
  })
}
