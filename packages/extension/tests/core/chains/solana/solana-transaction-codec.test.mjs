import { test } from 'node:test'
import { expect } from '@playwright/test'

import { encodeSolanaBase58 } from '../../../../src/infrastructure/chains/solana/solana-rpc-codecs.ts'
import {
  parseSolanaTransactionEnvelope,
  solanaBytesParseAsTransaction
} from '../../../../src/infrastructure/chains/solana/solana-transaction-codec.ts'
import { buildSolanaNativeTransfer } from '../../../../src/infrastructure/chains/solana/solana-transaction-builder.ts'

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'

test('extracts the exact legacy message used for RPC fee quoting', () => {
  const built = buildSolanaNativeTransfer({
    chainId,
    sender,
    recipient: 'SysvarRent111111111111111111111111111111111',
    recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    lamports: '1'
  })
  expect(parseSolanaTransactionEnvelope(built.transactionBase64)).toEqual({
    messageVersion: 'legacy',
    messageBase64: built.messageBase64,
    addressTableLookups: []
  })
})

test('extracts ordered v0 address lookup table indexes', () => {
  const tableKey = Uint8Array.from({ length: 32 }, () => 7)
  const message = Buffer.concat([
    Buffer.from([0x80, 1, 0, 1, 2]),
    Buffer.alloc(64),
    Buffer.alloc(32),
    Buffer.from([1, 1, 0, 0]),
    Buffer.from([1]),
    Buffer.from(tableKey),
    Buffer.from([2, 1, 3, 1, 5])
  ])
  const transaction = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message])
  expect(parseSolanaTransactionEnvelope(transaction.toString('base64'))).toEqual({
    messageVersion: 'v0',
    messageBase64: message.toString('base64'),
    addressTableLookups: [
      {
        accountKey: encodeSolanaBase58(tableKey),
        writableIndexes: [1, 3],
        readonlyIndexes: [5]
      }
    ]
  })
})

test('detects serialized transactions and the messages they sign', () => {
  const built = buildSolanaNativeTransfer({
    chainId,
    sender,
    recipient: 'SysvarRent111111111111111111111111111111111',
    recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    lamports: '1'
  })
  const transaction = Buffer.from(built.transactionBase64, 'base64')
  const message = Buffer.from(built.messageBase64, 'base64')
  expect(solanaBytesParseAsTransaction(transaction)).toBe(true)
  expect(solanaBytesParseAsTransaction(message)).toBe(true)

  const tableKey = Uint8Array.from({ length: 32 }, () => 7)
  const versionedMessage = Buffer.concat([
    Buffer.from([0x80, 1, 0, 1, 2]),
    Buffer.alloc(64),
    Buffer.alloc(32),
    Buffer.from([1, 1, 0, 0]),
    Buffer.from([1]),
    Buffer.from(tableKey),
    Buffer.from([2, 1, 3, 1, 5])
  ])
  const versionedTransaction = Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    versionedMessage
  ])
  expect(solanaBytesParseAsTransaction(versionedTransaction)).toBe(true)
  expect(solanaBytesParseAsTransaction(versionedMessage)).toBe(true)
  expect(solanaBytesParseAsTransaction(Buffer.from('hello'))).toBe(false)
  expect(solanaBytesParseAsTransaction(Buffer.from([0x80]))).toBe(false)
  expect(solanaBytesParseAsTransaction(new Uint8Array(1_233))).toBe(false)
})

test('rejects truncated and trailing transaction messages', () => {
  expect(() => parseSolanaTransactionEnvelope('AQ==')).toThrow(/signatures/)
  const malformed = Buffer.concat([Buffer.from([0]), Buffer.from([1, 0, 0]), Buffer.alloc(32)])
  expect(() => parseSolanaTransactionEnvelope(malformed.toString('base64'))).toThrow()
})
