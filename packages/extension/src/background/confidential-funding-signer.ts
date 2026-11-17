import type { ChainId } from '@/core/chains/domain'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { parseNearAccountId, supportsNearPrivateExecution } from '@/core/chains/near'
import { parseChainId } from '@/core/chains/registry'
import {
  confidentialNep413Recipient,
  type ConfidentialSignedPayload
} from '@/core/services/confidential-funding'
import { base64ToBytes } from '@/lib/bytes'
import { parseEvmAccountBinding, type ActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import {
  prepareNearNativeTransfer,
  prepareNearTokenTransfer
} from '@/infrastructure/chains/near/near-transfer-preparer'
import { encodeNearFunctionArgs } from '@/infrastructure/chains/near/near-rpc-codecs'
import type { NearBroadcastRpc, NearReadRpc } from '@/infrastructure/chains/near/near-rpc-types'
import {
  prepareSolanaNativeTransfer,
  prepareSolanaTokenTransfer
} from '@/infrastructure/chains/solana/solana-transfer-preparer'
import type {
  SolanaBroadcastRpc,
  SolanaReadRpc
} from '@/infrastructure/chains/solana/solana-rpc-types'
import type { NearMultichainSigningClient } from '@/infrastructure/keyring/multichain/near-signing-client'
import type { SolanaMultichainSigningClient } from '@/infrastructure/keyring/multichain/solana-signing-client'
import {
  assertEvmSigningSummaryMatchesPrepared,
  assertSignedEvmTransactionMatchesPrepared,
  createEvmSigningPreparePayload,
  parsePreparedEvmTransfer,
  type PreparedEvmTransfer
} from '@/infrastructure/chains/evm'
import { parseSigningCommandId } from '@/core/keyring/ports'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let output = ''
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) output += '1'
  for (let index = digits.length - 1; index >= 0; index -= 1)
    output += BASE58_ALPHABET[digits[index]]
  return output
}

function normalizeSignature(value: string): string {
  const hex = value.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error('Confidential ERC-191 signature is invalid')
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16))
  if (bytes[64] === 27 || bytes[64] === 28) bytes[64] -= 27
  if (bytes[64] !== 0 && bytes[64] !== 1) {
    throw new Error('Confidential ERC-191 signature recovery byte is invalid')
  }
  return `secp256k1:${encodeBase58(bytes)}`
}

export interface ConfidentialSigningIdentity {
  readonly context: ActiveEvmPortfolioContext
  readonly address: string
  readonly addressIndex: number
  readonly peaAddress: string
}

export interface ConfidentialNearSigningContext extends ActiveEvmPortfolioContext {
  readonly accountIndex: number
  readonly publicKey: string
}

export interface ConfidentialChainDeposit {
  readonly family: 'near' | 'solana'
  readonly chainId: ChainId
  readonly networkFeeRaw?: string
}

interface ConfidentialChainSigners {
  readonly near?: Readonly<{
    client: NearMultichainSigningClient
    rpc: NearReadRpc &
      NearBroadcastRpc & {
        broadcastSignedTransactionAndWait: (
          transactionBase64: string,
          signal?: AbortSignal
        ) => Promise<Readonly<Record<string, unknown>>>
      }
    rpcUrl: string
    chainId: ChainId
    loadContext: (chainId: ChainId) => Promise<ConfidentialNearSigningContext | null>
  }>
  readonly solana?: Readonly<{
    client: SolanaMultichainSigningClient
    rpc: SolanaReadRpc & SolanaBroadcastRpc
    chainId: ChainId
    loadContext: (
      chainId: ChainId
    ) => Promise<(ActiveEvmPortfolioContext & { readonly accountIndex: number }) | null>
  }>
}

const INTENTS_CONTRACT = 'intents.near'
const ADD_PUBLIC_KEY_GAS = '30000000000000'

function sameConfidentialAddress(left: string, right: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(left) && /^0x[0-9a-fA-F]{40}$/.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export class ConfidentialFundingSigner {
  constructor(
    private readonly signer: EvmMultichainSigningClient,
    private readonly loadContext: (chainId: ChainId) => Promise<ActiveEvmPortfolioContext | null>,
    private readonly runActiveOperation: <T>(
      operation: () => Promise<T>
    ) => Promise<T> = operation => operation(),
    private readonly chains: ConfidentialChainSigners = {}
  ) {}

  private async assertCurrentIdentity(
    identity: ConfidentialSigningIdentity,
    chainId: ChainId
  ): Promise<void> {
    const current = await this.resolveIdentity(chainId)
    if (
      current.context.chainAccount.scope.keyDomainId !==
        identity.context.chainAccount.scope.keyDomainId ||
      current.context.chainAccount.scope.accountId !==
        identity.context.chainAccount.scope.accountId ||
      !sameConfidentialAddress(current.address, identity.address) ||
      !sameConfidentialAddress(current.peaAddress, identity.peaAddress) ||
      current.addressIndex !== identity.addressIndex
    )
      throw new Error('Active Wallet Account changed before confidential signing')
  }

  async resolveIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity> {
    const parsed = parseChainId(chainId)
    if (parsed.namespace === 'near') return this.resolveNearIdentity(parsed.id)
    if (parsed.namespace === 'solana') return this.resolveSolanaIdentity(parsed.id)
    const context = await this.loadContext(chainId)
    if (!context || !supportsEvmPrivateExecution(context.keyDomainSource)) {
      throw new Error('Confidential funding requires an active software EVM Account')
    }
    const binding = parseEvmAccountBinding(context.chainAccount, chainId)
    const pea = await this.signer.deriveGlobalPea(
      context.chainAccount.scope.keyDomainId,
      binding.addressIndex
    )
    if (pea.address.toLowerCase() === binding.address.toLowerCase()) {
      throw new Error('Confidential address must be distinct from the Main address')
    }
    return Object.freeze({
      context,
      address: binding.address.toLowerCase(),
      addressIndex: binding.addressIndex,
      peaAddress: pea.address
    })
  }

  async signMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
  }): Promise<ConfidentialSignedPayload> {
    const namespace = parseChainId(input.chainId).namespace
    if (namespace === 'near') return this.signNearMessage(input)
    if (namespace === 'solana') return this.signSolanaMessage(input)
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.chainId)
      const prepared = await this.signer.prepare(
        input.identity.context.chainAccount.scope.keyDomainId,
        {
          kind: 'evm-personal-message',
          chainId: input.chainId,
          addressIndex: input.identity.addressIndex,
          message: new TextEncoder().encode(input.payload)
        }
      )
      let consumed = false
      try {
        if (
          prepared.execution.kind !== 'internal' ||
          prepared.operation !== 'message' ||
          prepared.expiresAt <= Date.now() ||
          prepared.summary.review.level === 'blocked'
        ) {
          throw new Error('Confidential signing request cannot be approved')
        }
        const result = await this.signer.confirm(
          input.identity.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        consumed = true
        if (
          result.kind !== 'signature' ||
          result.signature.encoding !== 'hex' ||
          result.address?.toLowerCase() !== input.identity.address
        ) {
          throw new Error('Confidential signature does not match the Main account')
        }
        return Object.freeze({
          standard: 'erc191' as const,
          payload: input.payload,
          signature: normalizeSignature(result.signature.value)
        })
      } finally {
        if (!consumed) {
          await this.signer
            .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
            .catch(() => {})
        }
      }
    })
  }

  async prepareTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly prepared: PreparedEvmTransfer
    readonly sourceDomain?: 'public' | 'private'
  }): Promise<
    Readonly<{
      commandId: string
      payloadFingerprint: string
      expiresAt: number
    }>
  > {
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.prepared.chainId)
      const expectedAddress =
        input.sourceDomain === 'private' ? input.identity.peaAddress : input.identity.address
      if (
        input.prepared.from.toLowerCase() !== expectedAddress.toLowerCase() ||
        input.prepared.addressIndex !== input.identity.addressIndex
      ) {
        throw new Error('Confidential funding deposit does not match the active Main account')
      }
      const prepared = await this.signer.prepare(
        input.identity.context.chainAccount.scope.keyDomainId,
        createEvmSigningPreparePayload(
          input.prepared,
          input.sourceDomain === 'private' ? 'private' : 'main'
        )
      )
      try {
        await assertEvmSigningSummaryMatchesPrepared(input.prepared, prepared.summary)
        if (
          prepared.execution.kind !== 'internal' ||
          prepared.operation !== 'transaction' ||
          prepared.summary.review.level === 'blocked' ||
          prepared.expiresAt <= Date.now()
        ) {
          throw new Error('Confidential funding deposit cannot be approved')
        }
        return Object.freeze({
          commandId: prepared.commandId,
          payloadFingerprint: prepared.payloadFingerprint.digestHex,
          expiresAt: prepared.expiresAt
        })
      } catch (error) {
        await this.signer
          .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
          .catch(() => {})
        throw error
      }
    })
  }

  async confirmTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
    readonly preparedTransfer: unknown
    readonly sourceDomain?: 'public' | 'private'
  }): Promise<
    Readonly<{
      prepared: PreparedEvmTransfer | ConfidentialChainDeposit
      rawTransaction: string
      transactionHash: string
    }>
  > {
    if (isConfidentialChainDeposit(input.preparedTransfer)) {
      return this.confirmChainDeposit(input.identity, input.commandId, input.preparedTransfer)
    }
    return this.runActiveOperation(async () => {
      const prepared = parsePreparedEvmTransfer(input.preparedTransfer)
      await this.assertCurrentIdentity(input.identity, prepared.chainId)
      const expectedAddress =
        input.sourceDomain === 'private' ? input.identity.peaAddress : input.identity.address
      if (
        prepared.from.toLowerCase() !== expectedAddress.toLowerCase() ||
        prepared.addressIndex !== input.identity.addressIndex
      ) {
        throw new Error('Confidential funding deposit does not match the active Main account')
      }
      const result = await this.signer.confirm(
        input.identity.context.chainAccount.scope.keyDomainId,
        parseSigningCommandId(input.commandId)
      )
      if (
        result.kind !== 'signed-payload' ||
        result.payload.encoding !== 'hex' ||
        !result.transactionId
      ) {
        throw new Error('Confidential funding deposit signature is invalid')
      }
      await assertSignedEvmTransactionMatchesPrepared(prepared, {
        rawTransaction: result.payload.value,
        transactionHash: result.transactionId
      })
      return Object.freeze({
        prepared,
        rawTransaction: result.payload.value,
        transactionHash: result.transactionId
      })
    })
  }

  async cancelTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
  }): Promise<void> {
    await this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(
        input.identity,
        input.identity.context.chainAccount.scope.chainId
      )
      await this.signer.cancel(
        input.identity.context.chainAccount.scope.keyDomainId,
        parseSigningCommandId(input.commandId)
      )
    })
  }

  async prepareChainDeposit(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly assetKind: 'native' | 'token'
    readonly assetNamespace: string
    readonly assetReference: string
    readonly assetId: string
    readonly decimals: number
    readonly recipient: string
    readonly amountRaw: string
    readonly sourceDomain: 'public' | 'private'
  }): Promise<
    Readonly<{
      commandId: string
      payloadFingerprint: string
      expiresAt: number
      preparedTransfer: ConfidentialChainDeposit
    }>
  > {
    const namespace = parseChainId(input.chainId).namespace
    if (namespace === 'near') return this.prepareNearDeposit(input)
    if (namespace === 'solana') return this.prepareSolanaDeposit(input)
    throw new Error('Confidential chain deposit signing is unavailable')
  }

  async broadcastDeposit(input: {
    readonly chainId: ChainId
    readonly rawTransaction: string
    readonly expectedTransactionHash: string
  }): Promise<void> {
    const namespace = parseChainId(input.chainId).namespace
    const hash =
      namespace === 'near'
        ? await this.chains.near?.rpc.broadcastSignedTransaction(input.rawTransaction)
        : namespace === 'solana'
          ? await this.chains.solana?.rpc.broadcastSignedTransaction(input.rawTransaction)
          : undefined
    if (!hash || hash !== input.expectedTransactionHash) {
      throw new Error('Confidential chain deposit broadcast did not match the signed transaction')
    }
  }

  private async resolveNearIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity> {
    const near = this.chains.near
    if (!near || near.chainId !== chainId) {
      throw new Error('Confidential NEAR signing chain is unavailable')
    }
    const context = await near.loadContext(chainId)
    if (!context || context.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('Confidential funding requires an active NEAR Account')
    }
    const address = parseNearAccountId(context.chainAccount.identity.value)
    if (!supportsNearPrivateExecution(context.keyDomainSource)) {
      throw new Error('NEAR private execution is unavailable')
    }
    const pea = await near.client.deriveNearPea(
      context.chainAccount.scope.keyDomainId,
      context.accountIndex
    )
    if (pea.address === address) {
      throw new Error('Confidential address must differ from the NEAR account')
    }
    return Object.freeze({
      context,
      address,
      addressIndex: context.accountIndex,
      peaAddress: pea.address
    })
  }

  private async resolveSolanaIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity> {
    const solana = this.chains.solana
    if (!solana || solana.chainId !== chainId) {
      throw new Error('Confidential Solana signing chain is unavailable')
    }
    const context = await solana.loadContext(chainId)
    if (!context || context.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('Confidential funding requires an active Solana Account')
    }
    const address = context.chainAccount.identity.value
    const accountIndex = readConfidentialAccountIndex(context)
    const pea = await solana.client.deriveSolanaPea(
      context.chainAccount.scope.keyDomainId,
      accountIndex
    )
    if (pea.address === address) {
      throw new Error('Confidential address must be distinct from the Main address')
    }
    return Object.freeze({
      context,
      address,
      addressIndex: accountIndex,
      peaAddress: pea.address
    })
  }

  private async signNearMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
  }): Promise<ConfidentialSignedPayload> {
    const near = this.chains.near
    if (!near) throw new Error('Confidential NEAR signing chain is unavailable')
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.chainId)
      const envelope = parseNep413SigningPayload(input.payload)
      const nonce = [...base64ToBytes(envelope.nonce)]
      if (nonce.length !== 32) throw new Error('NEAR confidential message nonce is invalid')
      const prepared = await near.client.prepare(
        input.identity.context.chainAccount.scope.keyDomainId,
        {
          kind: 'near-nep413-message',
          chainId: input.chainId,
          accountIndex: input.identity.addressIndex,
          request: Object.freeze({
            chainId: input.chainId,
            accountIndex: input.identity.addressIndex,
            accountId: input.identity.address,
            message: envelope.message,
            recipient: envelope.recipient,
            nonce,
            callbackUrl: null,
            state: null
          })
        }
      )
      let consumed = false
      try {
        if (prepared.operation !== 'message' || prepared.expiresAt <= Date.now()) {
          throw new Error('Confidential signing request cannot be approved')
        }
        const result = await near.client.confirm(
          input.identity.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        consumed = true
        if (
          result.kind !== 'signature' ||
          result.signature.encoding !== 'base64' ||
          result.address !== input.identity.address ||
          !result.publicKey
        ) {
          throw new Error('NEAR confidential signature payload is not a NEP-413 signature')
        }
        const signatureBytes = base64ToBytes(result.signature.value)
        if (signatureBytes.length !== 64) {
          throw new Error('NEAR confidential signature payload is not a NEP-413 signature')
        }
        const publicKey = result.publicKey.startsWith('ed25519:')
          ? result.publicKey
          : `ed25519:${result.publicKey}`
        await this.ensureNearIntentsPublicKey(input.identity, publicKey)
        return Object.freeze({
          standard: 'nep413' as const,
          payload: Object.freeze({
            recipient: envelope.recipient,
            nonce: envelope.nonce,
            message: envelope.message
          }),
          public_key: publicKey,
          signature: `ed25519:${encodeBase58(signatureBytes)}`
        })
      } finally {
        if (!consumed) {
          await near.client
            .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
            .catch(() => {})
        }
      }
    })
  }

  private async signSolanaMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
  }): Promise<ConfidentialSignedPayload> {
    const solana = this.chains.solana
    if (!solana) throw new Error('Confidential Solana signing chain is unavailable')
    if (input.identity.context.keyDomainSource.kind === 'hardware') {
      throw new Error('Solana message signing is not available for this hardware wallet.')
    }
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.chainId)
      const signerId = readPayloadSignerId(input.payload)
      const usePea = signerId === input.identity.peaAddress && signerId !== input.identity.address
      const prepared = await solana.client.prepare(
        input.identity.context.chainAccount.scope.keyDomainId,
        {
          kind: usePea ? 'pea-solana-message' : 'solana-message',
          chainId: input.chainId,
          accountIndex: input.identity.addressIndex,
          message: new TextEncoder().encode(input.payload)
        }
      )
      let consumed = false
      try {
        if (prepared.operation !== 'message' || prepared.expiresAt <= Date.now()) {
          throw new Error('Confidential signing request cannot be approved')
        }
        const result = await solana.client.confirm(
          input.identity.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        consumed = true
        if (
          result.kind !== 'signature' ||
          result.signature.encoding !== 'utf8' ||
          !result.publicKey ||
          !result.address
        ) {
          throw new Error(
            'Solana message signature payload is not the documented raw_ed25519 base58 signature'
          )
        }
        const expectedAddress = usePea ? input.identity.peaAddress : input.identity.address
        if (result.address !== expectedAddress || result.publicKey !== expectedAddress) {
          throw new Error('Solana confidential signature does not match the signing account')
        }
        return Object.freeze({
          standard: 'raw_ed25519' as const,
          payload: input.payload,
          public_key: `ed25519:${result.publicKey}`,
          signature: `ed25519:${result.signature.value}`
        })
      } finally {
        if (!consumed) {
          await solana.client
            .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
            .catch(() => {})
        }
      }
    })
  }

  private async prepareNearDeposit(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly assetKind: 'native' | 'token'
    readonly assetNamespace: string
    readonly assetReference: string
    readonly assetId: string
    readonly recipient: string
    readonly amountRaw: string
    readonly sourceDomain: 'public' | 'private'
  }) {
    const near = this.chains.near
    if (!near) throw new Error('Confidential NEAR signing chain is unavailable')
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.chainId)
      const keyDomainId = input.identity.context.chainAccount.scope.keyDomainId
      const context = input.identity.context
      const namedPublicKey =
        'publicKey' in context && typeof context.publicKey === 'string'
          ? context.publicKey
          : undefined
      let signerId = input.identity.address
      let publicKey = namedPublicKey
      let kind: 'near-transaction' | 'pea-near-transaction' = 'near-transaction'
      if (input.sourceDomain === 'private') {
        const pea = await near.client.deriveNearPea(keyDomainId, input.identity.addressIndex)
        // The preparer requires an implicit account's own key, not the named-account key.
        if (pea.address === input.identity.address) {
          throw new Error('Confidential address must differ from the NEAR account')
        }
        if (pea.address !== input.identity.peaAddress) {
          throw new Error('Confidential NEAR deposit signer does not match the private account')
        }
        signerId = pea.address
        publicKey = pea.publicKey
        kind = 'pea-near-transaction'
      }
      if (typeof publicKey !== 'string') {
        throw new Error('Confidential NEAR signing chain is unavailable')
      }
      const prepared =
        input.assetKind === 'native'
          ? await prepareNearNativeTransfer({
              chainId: input.chainId,
              accountIndex: input.identity.addressIndex,
              signerId,
              publicKey,
              receiverId: input.recipient,
              depositYocto: input.amountRaw,
              rpc: near.rpc
            })
          : input.assetNamespace === 'nep141'
            ? await prepareNearTokenTransfer({
                chainId: input.chainId,
                accountIndex: input.identity.addressIndex,
                signerId,
                publicKey,
                recipientId: input.recipient,
                contractId: input.assetReference.replace(/%5F/gi, '_'),
                assetId: input.assetId,
                amountRaw: input.amountRaw,
                rpc: near.rpc
              })
            : null
      if (!prepared) throw new Error('Confidential NEAR deposit is not available for this asset')
      return this.prepareChainTransaction(input.identity, {
        family: 'near',
        chainId: input.chainId,
        networkFeeRaw: prepared.maximumFeeYocto,
        prepare: () =>
          near.client.prepare(keyDomainId, {
            kind,
            chainId: input.chainId,
            accountIndex: input.identity.addressIndex,
            transaction: { ...prepared.transaction }
          })
      })
    })
  }

  private async prepareSolanaDeposit(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly assetKind: 'native' | 'token'
    readonly assetNamespace: string
    readonly assetReference: string
    readonly assetId: string
    readonly decimals: number
    readonly recipient: string
    readonly amountRaw: string
    readonly sourceDomain: 'public' | 'private'
  }) {
    const solana = this.chains.solana
    if (!solana) throw new Error('Confidential Solana signing chain is unavailable')
    const sender =
      input.sourceDomain === 'private' ? input.identity.peaAddress : input.identity.address
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.chainId)
      const prepared =
        input.assetKind === 'native'
          ? await prepareSolanaNativeTransfer({
              chainId: input.chainId,
              sender,
              recipient: input.recipient,
              lamports: input.amountRaw,
              rpc: solana.rpc
            })
          : input.assetNamespace === 'token'
            ? await prepareSolanaTokenTransfer({
                chainId: input.chainId,
                assetId: input.assetId,
                sender,
                recipient: input.recipient,
                mint: input.assetReference,
                decimals: input.decimals,
                amountRaw: input.amountRaw,
                rpc: solana.rpc
              })
            : null
      if (!prepared) throw new Error('Confidential Solana deposit is not available for this asset')
      const kind =
        input.sourceDomain === 'private' ? 'pea-solana-transaction' : 'solana-transaction'
      return this.prepareChainTransaction(input.identity, {
        family: 'solana',
        chainId: input.chainId,
        networkFeeRaw: prepared.feeLamports,
        prepare: () =>
          solana.client.prepare(input.identity.context.chainAccount.scope.keyDomainId, {
            kind,
            chainId: input.chainId,
            accountIndex: input.identity.addressIndex,
            transaction: prepared.transactionBase64
          })
      })
    })
  }

  private async prepareChainTransaction(
    identity: ConfidentialSigningIdentity,
    input: {
      readonly family: 'near' | 'solana'
      readonly chainId: ChainId
      readonly networkFeeRaw: string
      readonly prepare: () => Promise<{
        commandId: string
        payloadFingerprint: { digestHex: string }
        expiresAt: number
        operation: string
        summary: { review: { level: string } }
      }>
    }
  ) {
    const client = input.family === 'near' ? this.chains.near?.client : this.chains.solana?.client
    if (!client) throw new Error('Confidential chain deposit signing is unavailable')
    if (!/^[1-9][0-9]*$/.test(input.networkFeeRaw)) {
      throw new Error('Confidential chain deposit network fee is invalid')
    }
    const prepared = await input.prepare()
    try {
      if (
        prepared.operation !== 'transaction' ||
        prepared.summary.review.level === 'blocked' ||
        prepared.expiresAt <= Date.now()
      ) {
        throw new Error('Confidential funding deposit cannot be approved')
      }
      return Object.freeze({
        commandId: prepared.commandId,
        payloadFingerprint: prepared.payloadFingerprint.digestHex,
        expiresAt: prepared.expiresAt,
        preparedTransfer: Object.freeze({
          family: input.family,
          chainId: input.chainId,
          networkFeeRaw: input.networkFeeRaw
        })
      })
    } catch (error) {
      await client
        .cancel(
          identity.context.chainAccount.scope.keyDomainId,
          parseSigningCommandId(prepared.commandId)
        )
        .catch(() => {})
      throw error
    }
  }

  private async confirmChainDeposit(
    identity: ConfidentialSigningIdentity,
    commandId: string,
    preparedTransfer: ConfidentialChainDeposit
  ) {
    const client =
      preparedTransfer.family === 'near' ? this.chains.near?.client : this.chains.solana?.client
    if (!client) throw new Error('Confidential chain deposit signing is unavailable')
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(identity, preparedTransfer.chainId)
      const result = await client.confirm(
        identity.context.chainAccount.scope.keyDomainId,
        parseSigningCommandId(commandId)
      )
      if (
        result.kind !== 'signed-payload' ||
        result.payload.encoding !== 'base64' ||
        !result.transactionId
      ) {
        throw new Error('Confidential funding deposit signature is invalid')
      }
      return Object.freeze({
        prepared: preparedTransfer,
        rawTransaction: result.payload.value,
        transactionHash: result.transactionId
      })
    })
  }

  private async ensureNearIntentsPublicKey(
    identity: ConfidentialSigningIdentity,
    publicKey: string
  ): Promise<void> {
    if (/^[0-9a-f]{64}$/i.test(identity.address)) return
    const near = this.chains.near
    const context = identity.context
    if (!near || !('publicKey' in context) || typeof context.publicKey !== 'string') {
      throw new Error('Confidential NEAR signing chain is unavailable')
    }
    if (await this.nearHasPublicKey(identity.address, publicKey)) return
    const accessKey = await near.rpc.getAccessKey(identity.address, context.publicKey)
    if (!accessKey) {
      throw new Error('The derived NEAR access key is not registered on the sender account')
    }
    const nonce = BigInt(accessKey.nonce) + 1n
    const prepared = await near.client.prepare(identity.context.chainAccount.scope.keyDomainId, {
      kind: 'near-transaction',
      chainId: near.chainId,
      accountIndex: identity.addressIndex,
      transaction: {
        chainId: near.chainId,
        accountIndex: identity.addressIndex,
        signerId: identity.address,
        receiverId: INTENTS_CONTRACT,
        nonce: nonce.toString(),
        blockHash: accessKey.blockHash,
        actions: [
          {
            type: 'functionCall',
            methodName: 'add_public_key',
            args: encodeNearFunctionArgs({ public_key: publicKey }),
            gas: ADD_PUBLIC_KEY_GAS,
            depositYocto: '1'
          }
        ]
      }
    })
    let consumed = false
    try {
      const signed = await near.client.confirm(
        identity.context.chainAccount.scope.keyDomainId,
        prepared.commandId
      )
      consumed = true
      if (signed.kind !== 'signed-payload' || signed.payload.encoding !== 'base64') {
        throw new Error('NEAR add_public_key signature is invalid')
      }
      await near.rpc.broadcastSignedTransactionAndWait(signed.payload.value)
    } finally {
      if (!consumed) {
        await near.client
          .cancel(identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
          .catch(() => {})
      }
    }
    if (!(await this.nearHasPublicKey(identity.address, publicKey))) {
      throw new Error('NEAR Intents public key was not registered')
    }
  }

  private async nearHasPublicKey(accountId: string, publicKey: string): Promise<boolean> {
    const near = this.chains.near
    if (!near) return false
    const response = await fetch(near.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'confidential-has-public-key',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: INTENTS_CONTRACT,
          method_name: 'has_public_key',
          args_base64: btoa(JSON.stringify({ account_id: accountId, public_key: publicKey }))
        }
      })
    })
    const value = (await response.json()) as { result?: { result?: unknown } }
    if (!Array.isArray(value.result?.result)) {
      throw new Error('NEAR Intents public key query is invalid')
    }
    const encoded = String.fromCharCode(...value.result.result.map(Number))
    return JSON.parse(encoded) === true
  }
}

function readConfidentialAccountIndex(context: ActiveEvmPortfolioContext): number {
  if (
    'accountIndex' in context &&
    typeof context.accountIndex === 'number' &&
    Number.isSafeInteger(context.accountIndex) &&
    context.accountIndex >= 0
  ) {
    return context.accountIndex
  }
  throw new Error('Confidential Solana account index is unavailable')
}

function parseNep413SigningPayload(payload: string): {
  message: string
  recipient: string
  nonce: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NEAR confidential message payload must include message, recipient, and nonce')
  }
  const record = parsed as Record<string, unknown>
  const recipient = confidentialNep413Recipient(record.recipient)
  if (typeof record.message !== 'string' || !recipient || typeof record.nonce !== 'string') {
    throw new Error('NEAR confidential message payload must include message, recipient, and nonce')
  }
  return { message: record.message, recipient, nonce: record.nonce }
}

function readPayloadSignerId(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { signer_id?: unknown }
    return typeof parsed.signer_id === 'string' ? parsed.signer_id : ''
  } catch {
    return ''
  }
}

function isConfidentialChainDeposit(value: unknown): value is ConfidentialChainDeposit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    (record.family === 'near' || record.family === 'solana') && typeof record.chainId === 'string'
  )
}
