import type { ChainId } from '@/core/chains/domain'
import type { BitcoinConfidentialDepositClient } from '@/core/services/confidential-funding/bitcoin-confidential-deposit'
import {
  assertBitcoinDepositAddress,
  assertBitcoinDepositOutputs,
  assertBitcoinPayableDepositAddress
} from '@/core/services/confidential-funding/bitcoin-confidential-deposit'
import { detectBitcoinAddressType } from '@/infrastructure/chains/bitcoin/bitcoin-transaction-model'
import { loadActiveBitcoinDiscoveryContext } from '@/infrastructure/chains/bitcoin/bitcoin-discovery-coordinator'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import type { BackgroundBitcoinTransferController } from './bitcoin-transfer-controller'

type BitcoinDepositController = Pick<
  BackgroundBitcoinTransferController,
  'prepare' | 'approve' | 'reject'
>

function readTransactionHash(graph: {
  readonly segments: readonly {
    readonly evidence?: { readonly transactionHash?: string }
  }[]
}): string | null {
  for (const segment of graph.segments) {
    const hash = segment.evidence?.transactionHash
    if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) return hash
  }
  return null
}

export function createBitcoinConfidentialDepositClient(
  controller: BitcoinDepositController,
  storage = new IndexedDbStorageV2Repository()
): BitcoinConfidentialDepositClient {
  return {
    async resolvePublicSpendAddress(chainId) {
      const context = await loadActiveBitcoinDiscoveryContext(storage, chainId)
      const identity = context?.chainAccount.identity
      if (!context || identity?.kind !== 'account-identifier') {
        throw new Error('Bitcoin deposit signing is unavailable')
      }
      return Object.freeze({
        sourceAddress: assertBitcoinDepositAddress(identity.value, chainId)
      })
    },
    async preparePublicDeposit(input) {
      const addressType = detectBitcoinAddressType(input.sourceAddress, input.chainId as ChainId)
      const review = await controller.prepare(
        {
          recipient: input.recipient,
          amount: Object.freeze({ mode: 'exact' as const, valueSats: input.amountRaw })
        },
        undefined,
        'standard',
        addressType
      )
      const summary = review.review.summary
      if (summary.schema !== 'bitcoin.psbt.v1') {
        await controller.reject(review.graph.root.id).catch(() => {})
        throw new Error(
          'Bitcoin deposit outputs must pay the quote address and return change to the source'
        )
      }
      return Object.freeze({
        commandId: review.graph.root.id,
        payloadFingerprint: review.review.payloadFingerprint.digestHex,
        expiresAt: review.review.expiresAt,
        networkFeeRaw: summary.fields.feeSats,
        signerAddress: summary.fields.signer,
        outputs: summary.fields.outputs.map(output => Object.freeze({ address: output.address }))
      })
    },
    async preparePrivateDeposit(input) {
      const publicReceiveAddress = assertBitcoinDepositAddress(
        input.publicReceiveAddress,
        input.chainId
      )
      let privateExecutionAddress: string
      try {
        privateExecutionAddress = assertBitcoinDepositAddress(
          input.privateExecutionAddress,
          input.chainId
        )
      } catch {
        throw new Error('Bitcoin private deposit signing is unavailable')
      }
      // The PEA is the only spendable source. Do not build a PSBT from the public address.
      if (
        privateExecutionAddress.length === 0 ||
        privateExecutionAddress === publicReceiveAddress
      ) {
        throw new Error('Bitcoin private deposit signing is unavailable')
      }
      const counterpartyAddress =
        input.counterpartyAddress === undefined
          ? undefined
          : assertBitcoinDepositAddress(input.counterpartyAddress, input.chainId)
      assertBitcoinPayableDepositAddress(input.recipient, input.chainId)
      const review = await controller.prepare(
        {
          recipient: input.recipient,
          amount: Object.freeze({ mode: 'exact' as const, valueSats: input.amountRaw })
        },
        undefined,
        'standard',
        'p2wpkh',
        undefined,
        undefined,
        'private'
      )
      try {
        const summary = review.review.summary
        if (summary.schema !== 'bitcoin.psbt.v1') {
          throw new Error(
            'Bitcoin deposit outputs must pay the quote address and return change to the source'
          )
        }
        if (summary.fields.signer !== privateExecutionAddress) {
          throw new Error('Bitcoin deposit source does not match the selected address')
        }
        const forbidden = new Set<string>()
        if (publicReceiveAddress !== privateExecutionAddress) forbidden.add(publicReceiveAddress)
        if (counterpartyAddress !== undefined && counterpartyAddress !== privateExecutionAddress) {
          forbidden.add(counterpartyAddress)
        }
        let changeCount = 0
        for (const output of summary.fields.outputs) {
          if (output.address !== null && forbidden.has(output.address)) {
            throw new Error('Bitcoin deposit output pays another wallet address')
          }
          if (output.classification === 'change') {
            changeCount += 1
            if (output.address !== privateExecutionAddress) {
              throw new Error(
                'Bitcoin deposit outputs must pay the quote address and return change to the source'
              )
            }
          }
        }
        if (changeCount > 1) {
          throw new Error(
            'Bitcoin deposit outputs must pay the quote address and return change to the source'
          )
        }
        const outputs = summary.fields.outputs.map(output =>
          Object.freeze({ address: output.address })
        )
        assertBitcoinDepositOutputs({
          chainId: input.chainId,
          depositAddress: input.recipient,
          sourceAddress: privateExecutionAddress,
          counterpartyAddress: publicReceiveAddress,
          outputs
        })
        return Object.freeze({
          commandId: review.graph.root.id,
          payloadFingerprint: review.review.payloadFingerprint.digestHex,
          expiresAt: review.review.expiresAt,
          networkFeeRaw: summary.fields.feeSats,
          signerAddress: summary.fields.signer,
          outputs
        })
      } catch (error) {
        await controller.reject(review.graph.root.id).catch(() => {})
        throw error
      }
    },
    async confirmPublicDeposit(input) {
      const result = await controller.approve(input.commandId, input.payloadFingerprint)
      if (result.status !== 'broadcast') {
        throw new Error('Bitcoin deposit broadcast did not complete')
      }
      const transactionHash = readTransactionHash(result.graph)
      if (!transactionHash) throw new Error('Bitcoin deposit broadcast did not complete')
      // Approval already broadcast this transaction. The raw value is only a
      // correlation id for the confidential plan; broadcastDeposit must not send it again.
      return Object.freeze({ rawTransaction: transactionHash, transactionHash })
    },
    async rejectDeposit(commandId) {
      await controller.reject(commandId)
    }
  }
}
