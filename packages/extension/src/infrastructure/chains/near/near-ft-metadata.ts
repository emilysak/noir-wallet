import { parseNearAccountId } from '@/core/chains/near'

import { hasExactKeys, isRecord, readNearHash, readSafeUnsignedInteger } from './near-rpc-codecs'
import { NearRpcError, type NearFungibleTokenMetadata } from './near-rpc-types'

const MAXIMUM_METADATA_BYTES = 128 * 1024
const MAX_NAME_CODE_POINTS = 128
const MAX_SYMBOL_CODE_POINTS = 32
const DISPLAY_CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

function invalid(label: string): NearRpcError {
  return new NearRpcError('invalid-response', `Invalid ${label}`)
}

function decodeViewResult(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_METADATA_BYTES) {
    throw invalid('NEAR fungible token metadata')
  }
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index]
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw invalid('NEAR fungible token metadata byte')
    }
    bytes[index] = byte
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid('NEAR fungible token metadata UTF-8')
  }
}

function readDisplayText(value: unknown, maximumCodePoints: number): string {
  if (typeof value !== 'string') throw new Error('Invalid NEAR token metadata.')
  const normalized = value.normalize('NFC')
  if (
    normalized.length === 0 ||
    normalized.trim() !== normalized ||
    [...normalized].length > maximumCodePoints ||
    DISPLAY_CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new Error('Invalid NEAR token metadata.')
  }
  return normalized
}

export function parseNearFungibleTokenDisplay(
  name: unknown,
  symbol: unknown,
  decimals: unknown
): Readonly<{ name: string; symbol: string; decimals: number }> {
  if (!Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) {
    throw new Error('Invalid NEAR token metadata.')
  }
  return Object.freeze({
    name: readDisplayText(name, MAX_NAME_CODE_POINTS),
    symbol: readDisplayText(symbol, MAX_SYMBOL_CODE_POINTS),
    decimals: decimals as number
  })
}

/**
 * Parses a NEAR view-call response for NEP-141 ft_metadata.
 * `icon` and other optional fields are ignored; name, symbol, and decimals are required.
 */
export function parseNearFungibleTokenMetadata(
  value: unknown,
  contractIdValue: string
): NearFungibleTokenMetadata {
  const contractId = parseNearAccountId(contractIdValue, 'NEAR fungible token contract ID')
  if (!isRecord(value) || !hasExactKeys(value, ['block_hash', 'block_height', 'logs', 'result'])) {
    throw invalid('NEAR fungible token metadata response')
  }
  readNearHash(value.block_hash, 'NEAR fungible token metadata block hash')
  readSafeUnsignedInteger(value.block_height, 'NEAR fungible token metadata block height')
  if (!Array.isArray(value.logs) || value.logs.length > 256) {
    throw invalid('NEAR fungible token metadata logs')
  }
  for (const entry of value.logs) {
    if (typeof entry !== 'string' || entry.length > 4_096) {
      throw invalid('NEAR fungible token metadata logs')
    }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeViewResult(value.result))
  } catch (error) {
    if (error instanceof NearRpcError) throw error
    throw invalid('NEAR fungible token metadata value')
  }
  if (
    !isRecord(decoded) ||
    typeof decoded.name !== 'string' ||
    typeof decoded.symbol !== 'string'
  ) {
    throw invalid('NEAR fungible token metadata value')
  }
  try {
    const display = parseNearFungibleTokenDisplay(decoded.name, decoded.symbol, decoded.decimals)
    return Object.freeze({ contractId, ...display })
  } catch (error) {
    if (error instanceof NearRpcError) throw error
    throw invalid('NEAR fungible token metadata value')
  }
}
