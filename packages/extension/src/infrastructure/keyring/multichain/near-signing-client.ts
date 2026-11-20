import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseSigningSummary } from '@/core/keyring/domain'
import {
  type KeyringCommandBinding,
  type KeyringCommandPayload,
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningExecution,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
import { parseNearAccountId, parseNearBase58, parseNearPublicKey } from '@/core/chains/near'
import {
  NearFullAccessKeyDeletionRefused,
  type NearFullAccessKeyDeletionGrant,
  type NearFullAccessKeyDeletionIntent
} from '@/infrastructure/chains/near/near-full-access-key-removal'
import type { NearFullAccessKeyRemovalStore } from '@/infrastructure/chains/near/near-full-access-key-removal-store'
import { parseChainId } from '@/core/chains/registry'
import { ed25519 } from '@noble/curves/ed25519'
import * as utils from 'near-api-js/lib/utils/index.js'
import { base64ToBytes } from '@/lib/bytes'
import type { LedgerNearSigningRequest, LedgerNearSigningResponse } from '@/lib/ledger/near'
import {
  buildLedgerNearMessage,
  buildLedgerNearTransaction,
  ledgerNearSignedTransaction
} from './ledger-near-summary'
import { sha256, decodeBase64 } from './signing-adapter-common'
import {
  sameLedgerAccount,
  type LedgerSigningAccountBinding,
  type LedgerSigningBridge,
  type LedgerSigningResume
} from './ledger-signing-bridge'
import type { NearSigningPreparePayload } from './signing-adapter-near'
import {
  assertExactKeys,
  readBoolean,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString
} from './raw-wallet-engine'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'

const MAXIMUM_SIGNED_TRANSACTION_BYTES = 4 * 1024 * 1024

export type NearTransactionSigningPreparePayload = Extract<
  NearSigningPreparePayload,
  { readonly kind: 'near-transaction' }
>

export type NearMessageSigningPreparePayload = Extract<
  NearSigningPreparePayload,
  { readonly kind: 'near-nep413-message' }
>

export interface NearSigningCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface NearFullAccessKeyDeletionAuthorization {
  readonly keyDomainId: KeyDomainId
  readonly chainId: NearTransactionSigningPreparePayload['chainId']
  readonly signerId: string
  readonly deletedPublicKeys: readonly string[]
  readonly signal?: AbortSignal
}

export interface NearMultichainSigningClientOptions {
  readonly credentials: NearSigningCredentialBindingProvider
  readonly ledger?: LedgerSigningBridge<LedgerNearSigningRequest, LedgerNearSigningResponse>
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
  readonly authorizeFullAccessKeyDeletion?: (
    input: NearFullAccessKeyDeletionAuthorization
  ) => Promise<NearFullAccessKeyDeletionGrant | null>
  readonly fullAccessKeyRemovals?: NearFullAccessKeyRemovalStore
  readonly onFullAccessKeyRemovalRecorded?: () => void | Promise<void>
}

function samePublicKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return left.every(key => expected.has(key))
}

function deletedNearPublicKeys(payload: NearSigningPreparePayload): readonly string[] {
  if (payload.kind !== 'near-transaction') return Object.freeze([])
  const actions = payload.transaction.actions
  if (!Array.isArray(actions)) throw new Error('NEAR transaction actions are invalid')
  const keys = actions.map(action => {
    if (typeof action !== 'object' || action === null || Array.isArray(action)) {
      throw new Error('NEAR transaction action is invalid')
    }
    const record = action as Record<string, unknown>
    if (record.type !== 'deleteKey') return null
    return parseNearPublicKey(record.publicKey, 'NEAR deleteKey public key')
  })
  const deleted = keys.filter((key): key is string => key !== null)
  if (new Set(deleted).size !== deleted.length) {
    throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion target is duplicated')
  }
  return Object.freeze(deleted)
}

function acceptedFullAccessKeyGrant(
  signerId: string,
  chainId: string,
  requested: readonly string[],
  grant: NearFullAccessKeyDeletionGrant | null
): NearFullAccessKeyDeletionGrant | null {
  if (grant === null) return null
  if (grant.chainId !== chainId || grant.signerId !== signerId) {
    throw new Error('NEAR full-access key deletion grant does not match the transaction')
  }
  const deletedPublicKeys = grant.deletedPublicKeys.map(key =>
    parseNearPublicKey(key, 'NEAR full-access key deletion public key')
  )
  const retainedPublicKey = parseNearPublicKey(
    grant.retainedPublicKey,
    'NEAR full-access key deletion retained public key'
  )
  if (
    deletedPublicKeys.length === 0 ||
    new Set(deletedPublicKeys).size !== deletedPublicKeys.length ||
    deletedPublicKeys.some(key => !requested.includes(key) || key === retainedPublicKey)
  ) {
    throw new NearFullAccessKeyDeletionRefused(
      'NEAR full-access key deletion grant does not match the transaction'
    )
  }
  return Object.freeze({
    chainId,
    signerId,
    deletedPublicKeys: Object.freeze(deletedPublicKeys),
    retainedPublicKey
  })
}

function parseCanonicalBase64(value: unknown, label: string): string {
  const parsed = readString(value, label, Math.ceil((MAXIMUM_SIGNED_TRANSACTION_BYTES * 4) / 3) + 4)
  const padding = parsed.endsWith('==') ? 2 : parsed.endsWith('=') ? 1 : 0
  const decodedBytes = parsed.length % 4 === 0 ? (parsed.length / 4) * 3 - padding : -1
  if (
    decodedBytes <= 0 ||
    decodedBytes > MAXIMUM_SIGNED_TRANSACTION_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed)
  ) {
    throw new Error(`${label} must be bounded canonical base64`)
  }
  let binary: string
  try {
    binary = atob(parsed)
  } catch {
    throw new Error(`${label} must be bounded canonical base64`)
  }
  if (binary.length !== decodedBytes || btoa(binary) !== parsed) {
    throw new Error(`${label} must be bounded canonical base64`)
  }
  return parsed
}

function parsePreparedNearSigning(
  value: unknown,
  payload: NearSigningPreparePayload
): PreparedSigningCommand {
  const record = readRecord(value, 'Prepared NEAR signing command')
  assertExactKeys(
    record,
    [
      'commandId',
      'chainId',
      'operation',
      'summary',
      'payloadFingerprint',
      'execution',
      'expiresAt'
    ],
    [],
    'Prepared NEAR signing command'
  )
  if (record.chainId !== payload.chainId) {
    throw new Error('Prepared NEAR signing chain does not match the request')
  }
  const operation = payload.kind === 'near-transaction' ? 'transaction' : 'message'
  readLiteral(record.operation, [operation], 'NEAR signing operation')
  const fingerprint = readRecord(record.payloadFingerprint, 'NEAR signing payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], [], 'NEAR signing fingerprint')
  const digestHex = readString(fingerprint.digestHex, 'NEAR signing fingerprint digest', 64)
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new Error('NEAR signing fingerprint must be canonical lowercase hex')
  }
  const execution = readRecord(record.execution, 'NEAR signing execution')
  assertExactKeys(execution, ['kind'], [], 'NEAR signing execution')
  readLiteral(execution.kind, ['internal'], 'NEAR signing execution kind')
  return Object.freeze({
    commandId: parseSigningCommandId(readString(record.commandId, 'NEAR signing command ID', 128)),
    chainId: payload.chainId,
    operation,
    summary: parseSigningSummary(record.summary, {
      family: 'near',
      chainId: payload.chainId,
      operation
    }),
    payloadFingerprint: Object.freeze({
      algorithm: readLiteral(fingerprint.algorithm, ['sha256'], 'fingerprint algorithm'),
      digestHex
    }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt: readSafeInteger(record.expiresAt, 'NEAR signing expiry', Number.MAX_SAFE_INTEGER)
  })
}

function parseSignedNearTransaction(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed NEAR transaction')
  assertExactKeys(record, ['kind', 'payload', 'transactionId'], [], 'Signed NEAR transaction')
  readLiteral(record.kind, ['signed-payload'], 'signed NEAR result kind')
  const payload = readRecord(record.payload, 'Signed NEAR transaction payload')
  assertExactKeys(payload, ['encoding', 'value'], [], 'Signed NEAR transaction payload')
  readLiteral(payload.encoding, ['base64'], 'signed NEAR payload encoding')
  const signedTransaction = parseCanonicalBase64(payload.value, 'signed NEAR transaction')
  const transactionId = parseNearBase58(record.transactionId, 32, 'NEAR transaction hash')
  return Object.freeze({
    kind: 'signed-payload' as const,
    payload: Object.freeze({ encoding: 'base64' as const, value: signedTransaction }),
    transactionId
  })
}

function parseSignedNearMessage(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed NEAR message')
  assertExactKeys(record, ['kind', 'signature', 'publicKey', 'address'], [], 'Signed NEAR message')
  readLiteral(record.kind, ['signature'], 'signed NEAR result kind')
  const signature = readRecord(record.signature, 'Signed NEAR message signature')
  assertExactKeys(signature, ['encoding', 'value'], [], 'Signed NEAR message signature')
  readLiteral(signature.encoding, ['base64'], 'signed NEAR message signature encoding')
  const signatureValue = parseCanonicalBase64(signature.value, 'signed NEAR message signature')
  if (atob(signatureValue).length !== 64) {
    throw new Error('Signed NEAR message signature must be 64 bytes')
  }
  return Object.freeze({
    kind: 'signature' as const,
    signature: Object.freeze({ encoding: 'base64' as const, value: signatureValue }),
    publicKey: parseNearPublicKey(record.publicKey, 'Signed NEAR message public key'),
    address: parseNearAccountId(record.address, 'Signed NEAR message account ID')
  })
}

function parseSignedNearResult(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed NEAR result')
  return record.kind === 'signature'
    ? parseSignedNearMessage(value)
    : parseSignedNearTransaction(value)
}

function parseCancelledSigning(value: unknown): boolean {
  const record = readRecord(value, 'Cancelled NEAR signing command')
  assertExactKeys(record, ['cancelled'], [], 'Cancelled NEAR signing command')
  return readBoolean(record.cancelled, 'cancelled NEAR signing state')
}

export class NearMultichainSigningClient {
  private readonly commandClient: MultichainCommandClient
  private readonly confirming = new Set<SigningCommandId>()
  private readonly deletionIntents = new Map<
    SigningCommandId,
    {
      readonly keyDomainId: KeyDomainId
      readonly intent: NearFullAccessKeyDeletionIntent
    }
  >()
  private readonly ledgerPending = new Map<
    SigningCommandId,
    {
      readonly keyDomainId: KeyDomainId
      readonly accountIndex: number
      readonly account: LedgerSigningAccountBinding
      readonly request: LedgerNearSigningRequest
      readonly prepared: PreparedSigningCommand
    }
  >()

  constructor(private readonly options: NearMultichainSigningClientOptions) {
    this.commandClient = new MultichainCommandClient(
      new BackgroundMultichainTransport(options.forward),
      {
        defaultTimeoutMs: 120_000,
        maxTimeoutMs: 120_000,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.createCommandId === undefined
          ? {}
          : { createCommandId: options.createCommandId })
      }
    )
  }

  private async authorizeDeletion(
    keyDomainId: KeyDomainId,
    payload: NearSigningPreparePayload,
    signal?: AbortSignal
  ): Promise<NearFullAccessKeyDeletionGrant | null> {
    const deletedPublicKeys = deletedNearPublicKeys(payload)
    if (deletedPublicKeys.length === 0 || payload.kind !== 'near-transaction') return null
    if (!this.options.authorizeFullAccessKeyDeletion || !this.options.fullAccessKeyRemovals) {
      throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion cannot be verified')
    }
    const signerId = parseNearAccountId(payload.transaction.signerId, 'NEAR signer account ID')
    return acceptedFullAccessKeyGrant(
      signerId,
      payload.chainId,
      deletedPublicKeys,
      await this.options.authorizeFullAccessKeyDeletion({
        keyDomainId,
        chainId: payload.chainId,
        signerId,
        deletedPublicKeys,
        ...(signal === undefined ? {} : { signal })
      })
    )
  }

  private async persistDeletionIntent(
    keyDomainId: KeyDomainId,
    prepared: PreparedSigningCommand,
    grant: NearFullAccessKeyDeletionGrant
  ): Promise<void> {
    const store = this.options.fullAccessKeyRemovals
    if (!store) {
      throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion cannot be verified')
    }
    const intent = Object.freeze({ ...grant, expiresAt: prepared.expiresAt })
    try {
      await store.saveIntent(prepared.commandId, intent)
    } catch (error) {
      this.ledgerPending.delete(prepared.commandId)
      if (prepared.execution.kind === 'internal')
        await this.cancelWorker(keyDomainId, prepared.commandId)
      throw error
    }
    this.deletionIntents.set(prepared.commandId, Object.freeze({ keyDomainId, intent }))
  }

  private async cancelWorker(keyDomainId: KeyDomainId, commandId: SigningCommandId): Promise<void> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    await this.commandClient
      .execute(
        {
          operation: 'signing.cancel',
          binding,
          payload: { signingCommandId: commandId }
        },
        parseCancelledSigning
      )
      .catch(() => {})
  }

  private async abandonDeletion(
    keyDomainId: KeyDomainId,
    commandId: SigningCommandId
  ): Promise<void> {
    const ledger = this.ledgerPending.delete(commandId)
    this.deletionIntents.delete(commandId)
    await this.options.fullAccessKeyRemovals?.deleteIntent(commandId).catch(() => {})
    if (!ledger) await this.cancelWorker(keyDomainId, commandId)
  }

  private async reauthorizeDeletion(
    keyDomainId: KeyDomainId,
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<NearFullAccessKeyDeletionIntent | null> {
    const remembered = this.deletionIntents.get(commandId)
    const intent =
      remembered?.intent ??
      (await this.options.fullAccessKeyRemovals?.readIntent(commandId)) ??
      null
    if (!intent) return null
    if (remembered && remembered.keyDomainId !== keyDomainId) {
      throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion scope changed')
    }
    if ((this.options.now?.() ?? Date.now()) >= intent.expiresAt) {
      await this.abandonDeletion(keyDomainId, commandId)
      throw new NearFullAccessKeyDeletionRefused(
        'NEAR full-access key deletion authorization expired'
      )
    }
    if (!this.options.authorizeFullAccessKeyDeletion) {
      throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion cannot be verified')
    }
    let grant: NearFullAccessKeyDeletionGrant | null
    try {
      grant = acceptedFullAccessKeyGrant(
        intent.signerId,
        intent.chainId,
        intent.deletedPublicKeys,
        await this.options.authorizeFullAccessKeyDeletion({
          keyDomainId,
          chainId: intent.chainId as NearFullAccessKeyDeletionAuthorization['chainId'],
          signerId: intent.signerId,
          deletedPublicKeys: intent.deletedPublicKeys,
          ...(signal === undefined ? {} : { signal })
        })
      )
    } catch (error) {
      if (error instanceof NearFullAccessKeyDeletionRefused) {
        await this.abandonDeletion(keyDomainId, commandId)
      }
      throw error
    }
    if (!grant || !samePublicKeys(grant.deletedPublicKeys, intent.deletedPublicKeys)) {
      await this.abandonDeletion(keyDomainId, commandId)
      throw new NearFullAccessKeyDeletionRefused(
        'NEAR full-access key deletion is no longer authorized'
      )
    }
    const updated = Object.freeze({ ...intent, retainedPublicKey: grant.retainedPublicKey })
    this.deletionIntents.set(commandId, Object.freeze({ keyDomainId, intent: updated }))
    return updated
  }

  private async recordDeletion(
    commandId: SigningCommandId,
    intent: NearFullAccessKeyDeletionIntent,
    transactionId: string
  ): Promise<void> {
    const store = this.options.fullAccessKeyRemovals
    if (!store) {
      throw new NearFullAccessKeyDeletionRefused('NEAR full-access key deletion cannot be verified')
    }
    const recordedAt = this.options.now?.() ?? Date.now()
    for (const deletedPublicKey of intent.deletedPublicKeys) {
      await store.recordRemoval(
        Object.freeze({
          chainId: intent.chainId,
          transactionId,
          signerId: intent.signerId,
          deletedPublicKey,
          retainedPublicKey: intent.retainedPublicKey,
          recordedAt
        })
      )
    }
    this.deletionIntents.delete(commandId)
    await store.deleteIntent(commandId)
    await this.options.onFullAccessKeyRemovalRecorded?.()
  }

  async prepare(
    keyDomainId: KeyDomainId,
    payload: NearSigningPreparePayload,
    signal?: AbortSignal
  ): Promise<PreparedSigningCommand> {
    const grant = await this.authorizeDeletion(keyDomainId, payload, signal)
    const finish = async (prepared: PreparedSigningCommand) => {
      if (grant) await this.persistDeletionIntent(keyDomainId, prepared, grant)
      return prepared
    }
    if (this.options.ledger) {
      const account = await this.options.ledger.resolveAccount(
        keyDomainId,
        payload.chainId,
        payload.accountIndex
      )
      if (account) {
        const built =
          payload.kind === 'near-transaction'
            ? await buildLedgerNearTransaction(payload, account.publicKey, account.address)
            : await buildLedgerNearMessage(payload, account.publicKey, account.address)
        const digestHex =
          payload.kind === 'near-transaction'
            ? await sha256(new TextEncoder().encode(JSON.stringify(payload.transaction)))
            : await sha256(decodeBase64(built.payloadBase64))
        const commandId = parseSigningCommandId(
          this.options.createCommandId?.() ?? crypto.randomUUID()
        )
        const request: LedgerNearSigningRequest = {
          kind: payload.kind,
          chainId: payload.chainId as LedgerNearSigningRequest['chainId'],
          path: account.path,
          payloadBase64: built.payloadBase64,
          expectedPublicKey: account.publicKey
        }
        const prepared: PreparedSigningCommand = Object.freeze({
          commandId,
          chainId: payload.chainId,
          operation: payload.kind === 'near-transaction' ? 'transaction' : 'message',
          summary: built.summary,
          payloadFingerprint: { algorithm: 'sha256' as const, digestHex },
          execution: {
            kind: 'external' as const,
            request: { encoding: 'base64' as const, value: built.payloadBase64 }
          },
          expiresAt: (this.options.now?.() ?? Date.now()) + 120_000
        })
        this.ledgerPending.set(commandId, {
          keyDomainId,
          accountIndex: payload.accountIndex,
          account,
          request,
          prepared
        })
        return finish(prepared)
      }
    }
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return finish(
      await this.commandClient.execute(
        {
          operation: 'signing.prepare',
          binding,
          payload: payload as unknown as KeyringCommandPayload,
          signal
        },
        value => parsePreparedNearSigning(value, payload)
      )
    )
  }

  async confirm(
    keyDomainId: KeyDomainId,
    commandId: SigningCommandId,
    signal?: AbortSignal,
    origin?: string,
    execution?: SigningExecution,
    resume?: LedgerSigningResume<NearSigningPreparePayload>
  ): Promise<SigningResult> {
    if (this.confirming.has(commandId))
      throw new Error('NEAR signing command is already confirming')
    this.confirming.add(commandId)
    try {
      const deletion = await this.reauthorizeDeletion(keyDomainId, commandId, signal)
      const complete = async (result: SigningResult) => {
        if (deletion && result.kind === 'signed-payload') {
          if (!result.transactionId) throw new Error('Signed NEAR transaction has no hash')
          await this.recordDeletion(commandId, deletion, result.transactionId)
        }
        return result
      }
      if (
        !this.ledgerPending.has(commandId) &&
        execution?.kind === 'external' &&
        resume &&
        this.options.ledger
      ) {
        const { payload, prepared } = resume
        const account = await this.options.ledger.resolveAccount(
          keyDomainId,
          payload.chainId,
          payload.accountIndex
        )
        if (!account || account.accountId !== resume.accountId)
          throw new Error('Ledger NEAR recovery account changed')
        const built =
          payload.kind === 'near-transaction'
            ? await buildLedgerNearTransaction(payload, account.publicKey, account.address)
            : await buildLedgerNearMessage(payload, account.publicKey, account.address)
        const digestHex =
          payload.kind === 'near-transaction'
            ? await sha256(new TextEncoder().encode(JSON.stringify(payload.transaction)))
            : await sha256(decodeBase64(built.payloadBase64))
        if (
          prepared.commandId !== commandId ||
          prepared.chainId !== payload.chainId ||
          prepared.execution.kind !== 'external' ||
          prepared.execution.request.encoding !== 'base64' ||
          prepared.execution.request.value !== built.payloadBase64 ||
          execution.request.encoding !== 'base64' ||
          execution.request.value !== built.payloadBase64 ||
          digestHex !== prepared.payloadFingerprint.digestHex ||
          JSON.stringify(built.summary) !== JSON.stringify(prepared.summary) ||
          (this.options.now?.() ?? Date.now()) >= prepared.expiresAt
        ) {
          throw new Error('Ledger NEAR recovery binding is invalid or expired')
        }
        this.ledgerPending.set(commandId, {
          keyDomainId,
          accountIndex: payload.accountIndex,
          account,
          prepared,
          request: {
            kind: payload.kind,
            chainId: payload.chainId as LedgerNearSigningRequest['chainId'],
            path: account.path,
            expectedPublicKey: account.publicKey,
            payloadBase64: built.payloadBase64
          }
        })
      }
      const pending = this.ledgerPending.get(commandId)
      if (pending) {
        this.ledgerPending.delete(commandId)
        if (pending.keyDomainId !== keyDomainId || !this.options.ledger)
          throw new Error('Ledger signing scope changed')
        const validate = async () => {
          if ((this.options.now?.() ?? Date.now()) >= pending.prepared.expiresAt)
            throw new Error('Ledger signing request expired')
          const current =
            (await this.options.ledger?.resolveAccount(
              keyDomainId,
              parseChainId(pending.request.chainId).id,
              pending.accountIndex
            )) ?? null
          if (!sameLedgerAccount(pending.account, current))
            throw new Error('Ledger NEAR account changed')
        }
        await validate()
        const response = await this.options.ledger.requestSignature(pending.request, {
          scope: {
            keyDomainId,
            accountId: pending.account.accountId,
            chainId: pending.prepared.chainId
          },
          payloadFingerprint: pending.prepared.payloadFingerprint,
          expiresAt: pending.prepared.expiresAt,
          summary: pending.prepared.summary,
          validate,
          ...(origin === undefined ? {} : { origin }),
          ...(signal === undefined ? {} : { signal })
        })
        await validate()
        if (
          response.kind !== pending.request.kind ||
          response.publicKey !== pending.account.publicKey
        ) {
          throw new Error('Ledger NEAR response account does not match')
        }
        const signature = base64ToBytes(response.signatureBase64)
        const digest = new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new Uint8Array(decodeBase64(pending.request.payloadBase64))
          )
        )
        const publicKey = utils.PublicKey.from(pending.account.publicKey).data
        if (
          signature.length !== 64 ||
          !ed25519.verify(signature, digest, publicKey, { zip215: false })
        ) {
          throw new Error('Ledger NEAR response signature is invalid')
        }
        if (pending.request.kind === 'near-nep413-message') {
          return complete({
            kind: 'signature',
            signature: { encoding: 'base64', value: response.signatureBase64 },
            publicKey: pending.account.publicKey,
            address: pending.account.address
          })
        }
        const signed = await ledgerNearSignedTransaction(
          pending.request.payloadBase64,
          response.signatureBase64
        )
        return complete({
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: signed.signedTransactionBase64 },
          transactionId: signed.transactionHash
        })
      }
      if (execution?.kind === 'external') {
        throw new Error('Ledger NEAR approval session expired; prepare the transfer again')
      }
      const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
      return complete(
        await this.commandClient.execute(
          {
            operation: 'signing.confirm',
            binding,
            payload: { signingCommandId: commandId },
            signal
          },
          parseSignedNearResult
        )
      )
    } finally {
      this.confirming.delete(commandId)
    }
  }

  async cancel(
    keyDomainId: KeyDomainId,
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<void> {
    this.deletionIntents.delete(commandId)
    await this.options.fullAccessKeyRemovals?.deleteIntent(commandId).catch(() => {})
    if (this.ledgerPending.delete(commandId)) return
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    await this.commandClient.execute(
      {
        operation: 'signing.cancel',
        binding,
        payload: { signingCommandId: commandId },
        signal
      },
      parseCancelledSigning
    )
  }

  destroy(): Promise<void> {
    return this.commandClient.destroy()
  }
}
