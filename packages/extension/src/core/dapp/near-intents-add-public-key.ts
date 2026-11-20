import {
  isInternalSignatureDomain,
  MAX_NEAR_INTENTS_JSON_DEPTH,
  type NearIntentsPayloadFinding
} from './internal-signature-domains'

export const NEAR_DAPP_ADD_INTENTS_PUBLIC_KEY_REJECTION =
  'NEAR dApp requests cannot add an Intents public key.'

const ADD_PUBLIC_KEY_INTENT = 'add_public_key'

// A direct call registers the key on the verifier. The same object inside a
// signed payload or execute_intents arguments does too, so both shapes are
// identified. Free text that merely mentions the name is not a registration.
export function nearDappFunctionCallAddsIntentsPublicKey(
  receiverId: string,
  methodName: string,
  args: unknown
): boolean {
  if (methodName === ADD_PUBLIC_KEY_INTENT && isInternalSignatureDomain(receiverId)) return true
  const finding = inspectFunctionCallArgs(args)
  if (finding === 'match') return true
  // Unread JSON on the verifier can still hide the intent. Other contracts
  // are rejected only when the intent object is actually visible.
  return finding === 'incomplete' && isInternalSignatureDomain(receiverId)
}

export function nearMessageAddsIntentsPublicKey(request: {
  readonly message: string
  readonly callbackUrl: string | null
}): boolean {
  if (inspectIntentsAddPublicKey(request.message) === 'match') return true
  return request.callbackUrl !== null && inspectIntentsAddPublicKey(request.callbackUrl) === 'match'
}

export function inspectIntentsAddPublicKey(value: unknown): NearIntentsPayloadFinding {
  return inspectStructured(value, 0)
}

function inspectFunctionCallArgs(args: unknown): NearIntentsPayloadFinding {
  if (args instanceof Uint8Array) {
    const text = decodeStrictUtf8(args)
    return text === null ? 'clear' : inspectIntentsAddPublicKey(text)
  }
  if (isByteArray(args)) {
    const text = decodeStrictUtf8(Uint8Array.from(args))
    return text === null ? 'clear' : inspectIntentsAddPublicKey(text)
  }
  return inspectIntentsAddPublicKey(args)
}

function inspectStructured(value: unknown, depth: number): NearIntentsPayloadFinding {
  if (typeof value === 'string') return inspectJsonText(value, depth)
  if (Array.isArray(value)) {
    let finding: NearIntentsPayloadFinding = 'clear'
    for (const item of value) {
      finding = combineFindings(finding, inspectStructured(item, depth))
      if (finding === 'match') return finding
    }
    return finding
  }
  if (!isRecord(value)) return 'clear'
  if (value.intent === ADD_PUBLIC_KEY_INTENT) return 'match'
  let finding: NearIntentsPayloadFinding = 'clear'
  for (const child of Object.values(value)) {
    finding = combineFindings(finding, inspectStructured(child, depth))
    if (finding === 'match') return finding
  }
  return finding
}

function inspectJsonText(payload: string, depth: number): NearIntentsPayloadFinding {
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'clear'
  if (depth >= MAX_NEAR_INTENTS_JSON_DEPTH) return 'incomplete'
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return 'clear'
  }
  return inspectStructured(parsed, depth + 1)
}

function combineFindings(
  left: NearIntentsPayloadFinding,
  right: NearIntentsPayloadFinding
): NearIntentsPayloadFinding {
  if (left === 'match' || right === 'match') return 'match'
  if (left === 'incomplete' || right === 'incomplete') return 'incomplete'
  return 'clear'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isByteArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (new TextEncoder().encode(decoded).byteLength !== bytes.byteLength) return null
    return decoded
  } catch {
    return null
  }
}
