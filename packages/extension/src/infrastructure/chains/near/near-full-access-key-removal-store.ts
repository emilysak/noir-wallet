import { parseNearAccountId, parseNearBase58, parseNearPublicKey } from '@/core/chains/near'
import { parseChainId } from '@/core/chains/registry'
import { parseSigningCommandId, type SigningCommandId } from '@/core/keyring/ports'
import type { SessionStorageArea } from '../pending-transaction-store'

import type {
  NearFullAccessKeyDeletionIntent,
  NearFullAccessKeyRemovalRecord
} from './near-full-access-key-removal'

const INTENT_PREFIX = 'near_full_access_key_removal_intent:'
const REMOVAL_PREFIX = 'near_full_access_key_removal:'
const SCHEMA_VERSION = 1 as const
const MAXIMUM_RECORDS = 32

export interface NearFullAccessKeyRemovalStore {
  readonly saveIntent: (
    commandId: SigningCommandId,
    intent: NearFullAccessKeyDeletionIntent
  ) => Promise<void>
  readonly readIntent: (
    commandId: SigningCommandId
  ) => Promise<NearFullAccessKeyDeletionIntent | null>
  readonly deleteIntent: (commandId: SigningCommandId) => Promise<void>
  readonly recordRemoval: (record: NearFullAccessKeyRemovalRecord) => Promise<void>
  readonly listRemovals: (chainId: string) => Promise<readonly NearFullAccessKeyRemovalRecord[]>
  readonly deleteRemoval: (record: NearFullAccessKeyRemovalRecord) => Promise<void>
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
  required: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== required.length ||
    !required.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function readNearChainId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} chain is not NEAR`)
  const chainId = parseChainId(value)
  if (chainId.namespace !== 'near') throw new Error(`${label} chain is not NEAR`)
  return chainId.id
}

function parseGrantFields(record: Record<string, unknown>, label: string) {
  const chainId = readNearChainId(record.chainId, label)
  const deletedValue = record.deletedPublicKeys
  if (!Array.isArray(deletedValue) || deletedValue.length === 0 || deletedValue.length > 100) {
    throw new Error(`${label} deleted keys are invalid`)
  }
  const deletedPublicKeys = Object.freeze(
    deletedValue.map(key => parseNearPublicKey(key, `${label} deleted public key`))
  )
  if (new Set(deletedPublicKeys).size !== deletedPublicKeys.length) {
    throw new Error(`${label} deleted keys are invalid`)
  }
  return Object.freeze({
    chainId,
    signerId: parseNearAccountId(record.signerId, `${label} signer account ID`),
    deletedPublicKeys,
    retainedPublicKey: parseNearPublicKey(record.retainedPublicKey, `${label} retained public key`)
  })
}

export function parseNearFullAccessKeyDeletionIntent(
  value: unknown
): NearFullAccessKeyDeletionIntent {
  const record = readRecord(value, 'NEAR full-access key deletion intent')
  assertExactKeys(
    record,
    ['schemaVersion', 'chainId', 'signerId', 'deletedPublicKeys', 'retainedPublicKey', 'expiresAt'],
    'NEAR full-access key deletion intent'
  )
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported NEAR full-access key deletion intent schema')
  }
  return Object.freeze({
    ...parseGrantFields(record, 'NEAR full-access key deletion intent'),
    expiresAt: readTimestamp(record.expiresAt, 'NEAR full-access key deletion intent expiry')
  })
}

export function parseNearFullAccessKeyRemovalRecord(
  value: unknown
): NearFullAccessKeyRemovalRecord {
  const record = readRecord(value, 'NEAR full-access key removal')
  assertExactKeys(
    record,
    [
      'schemaVersion',
      'chainId',
      'transactionId',
      'signerId',
      'deletedPublicKey',
      'retainedPublicKey',
      'recordedAt'
    ],
    'NEAR full-access key removal'
  )
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported NEAR full-access key removal schema')
  }
  const chainId = readNearChainId(record.chainId, 'NEAR full-access key removal')
  return Object.freeze({
    chainId,
    transactionId: parseNearBase58(
      record.transactionId,
      32,
      'NEAR full-access key removal transaction'
    ),
    signerId: parseNearAccountId(record.signerId, 'NEAR full-access key removal signer account ID'),
    deletedPublicKey: parseNearPublicKey(
      record.deletedPublicKey,
      'NEAR full-access key removal deleted public key'
    ),
    retainedPublicKey: parseNearPublicKey(
      record.retainedPublicKey,
      'NEAR full-access key removal retained public key'
    ),
    recordedAt: readTimestamp(record.recordedAt, 'NEAR full-access key removal recorded time')
  })
}

function intentKey(commandId: SigningCommandId): string {
  return `${INTENT_PREFIX}${commandId}`
}

function removalKey(record: NearFullAccessKeyRemovalRecord): string {
  return `${REMOVAL_PREFIX}${record.chainId}\n${record.transactionId}\n${record.deletedPublicKey}`
}

export class ChromeSessionNearFullAccessKeyRemovalStore implements NearFullAccessKeyRemovalStore {
  constructor(private readonly storage: SessionStorageArea = chrome.storage.session) {}

  async saveIntent(
    commandIdValue: SigningCommandId,
    intent: NearFullAccessKeyDeletionIntent
  ): Promise<void> {
    const commandId = parseSigningCommandId(commandIdValue)
    const parsed = parseNearFullAccessKeyDeletionIntent({
      schemaVersion: SCHEMA_VERSION,
      ...intent
    })
    const stored = await this.storage.get(null)
    const keys = Object.keys(stored).filter(key => key.startsWith(INTENT_PREFIX))
    if (!keys.includes(intentKey(commandId)) && keys.length >= MAXIMUM_RECORDS) {
      throw new Error('NEAR full-access key deletion intent capacity exceeded')
    }
    await this.storage.set({
      [intentKey(commandId)]: { schemaVersion: SCHEMA_VERSION, ...parsed }
    })
  }

  async readIntent(
    commandIdValue: SigningCommandId
  ): Promise<NearFullAccessKeyDeletionIntent | null> {
    const commandId = parseSigningCommandId(commandIdValue)
    const key = intentKey(commandId)
    const stored = await this.storage.get(key)
    const value = stored[key]
    if (value === undefined) return null
    return parseNearFullAccessKeyDeletionIntent(value)
  }

  async deleteIntent(commandIdValue: SigningCommandId): Promise<void> {
    await this.storage.remove(intentKey(parseSigningCommandId(commandIdValue)))
  }

  async recordRemoval(record: NearFullAccessKeyRemovalRecord): Promise<void> {
    const parsed = parseNearFullAccessKeyRemovalRecord({
      schemaVersion: SCHEMA_VERSION,
      ...record
    })
    const stored = await this.storage.get(null)
    const key = removalKey(parsed)
    const keys = Object.keys(stored).filter(candidate => candidate.startsWith(REMOVAL_PREFIX))
    if (!keys.includes(key) && keys.length >= MAXIMUM_RECORDS) {
      throw new Error('NEAR full-access key removal capacity exceeded')
    }
    await this.storage.set({ [key]: { schemaVersion: SCHEMA_VERSION, ...parsed } })
  }

  async listRemovals(chainIdValue: string): Promise<readonly NearFullAccessKeyRemovalRecord[]> {
    const chainId = parseChainId(chainIdValue).id
    const stored = await this.storage.get(null)
    const records = Object.entries(stored)
      .filter(([key]) => key.startsWith(REMOVAL_PREFIX))
      .map(([key, value]) => {
        const record = parseNearFullAccessKeyRemovalRecord(value)
        if (removalKey(record) !== key) {
          throw new Error('NEAR full-access key removal storage key mismatch')
        }
        return record
      })
      .filter(record => record.chainId === chainId)
    if (records.length > MAXIMUM_RECORDS) {
      throw new Error('NEAR full-access key removal capacity exceeded')
    }
    records.sort(
      (left, right) =>
        left.transactionId.localeCompare(right.transactionId) ||
        left.deletedPublicKey.localeCompare(right.deletedPublicKey)
    )
    return Object.freeze(records)
  }

  async deleteRemoval(record: NearFullAccessKeyRemovalRecord): Promise<void> {
    await this.storage.remove(
      removalKey(
        parseNearFullAccessKeyRemovalRecord({
          schemaVersion: SCHEMA_VERSION,
          ...record
        })
      )
    )
  }
}
