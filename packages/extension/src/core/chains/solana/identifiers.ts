const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0 || value.length > 128) {
    throw new Error('Solana public key must be bounded base58')
  }
  const littleEndianBytes = [0]
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) throw new Error('Solana public key must be base58')
    let carry = digit
    for (let index = 0; index < littleEndianBytes.length; index += 1) {
      carry += littleEndianBytes[index] * 58
      littleEndianBytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      littleEndianBytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let leadingZeroBytes = 0
  while (value[leadingZeroBytes] === '1') leadingZeroBytes += 1
  const significantBytes =
    littleEndianBytes.length === 1 && littleEndianBytes[0] === 0 ? [] : littleEndianBytes
  const decoded = new Uint8Array(leadingZeroBytes + significantBytes.length)
  for (let index = 0; index < significantBytes.length; index += 1) {
    decoded[decoded.length - 1 - index] = significantBytes[index]
  }
  return decoded
}

export function parseSolanaPublicKey(value: unknown): string {
  if (typeof value !== 'string' || decodeBase58(value).length !== 32) {
    throw new Error('Solana public key must encode 32 bytes')
  }
  return value
}

// Confidential Intents identifies a Solana signer by the hex encoding of its
// public-key bytes. A base58 address is only valid as an on-chain recipient.
export function confidentialIntentsAccountId(value: string): string {
  let decoded: Uint8Array
  try {
    decoded = decodeBase58(value)
  } catch {
    return value
  }
  if (decoded.length !== 32) return value
  let hex = ''
  for (const byte of decoded) hex += byte.toString(16).padStart(2, '0')
  return hex
}
