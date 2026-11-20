// Domains the wallet signs for its own NEAR Intents flows. A dApp signature
// bound to one of these domains can be replayed as that internal authorization.
export const INTERNAL_SIGNATURE_DOMAINS = Object.freeze(['intents.near', 'intents.far'] as const)

export const INTERNAL_SIGNATURE_DOMAIN_REJECTION_MESSAGE =
  'Noir Wallet rejected this NEAR Intents signature request.'

const NEAR_INTENTS_FIELDS = ['signer_id', 'intents', 'nonce', 'deadline'] as const

// Four JSON layers are inspected fully. A deeper JSON-shaped value stays
// incomplete so an unread layer cannot be treated as a clear payload.
export const MAX_NEAR_INTENTS_JSON_DEPTH = 4

export type NearIntentsPayloadFinding = 'match' | 'clear' | 'incomplete'

export function isInternalSignatureDomain(value: string): boolean {
  return INTERNAL_SIGNATURE_DOMAINS.some(domain => domain === value)
}

// NEP-413 signs message, recipient, and callbackUrl. Recipient is the
// signature domain, so only an exact internal account id matches. Message and
// callbackUrl can still carry the payload the wallet signs internally.
// `state` is returned to the dApp and is not part of the signature.
export function nearMessageUsesInternalSignatureDomain(request: {
  readonly message: string
  readonly recipient: string
  readonly callbackUrl: string | null
}): boolean {
  if (isInternalSignatureDomain(request.recipient)) return true
  if (isNearIntentsSigningPayload(request.message)) return true
  return request.callbackUrl !== null && isNearIntentsSigningPayload(request.callbackUrl)
}

export function inspectNearIntentsSigningPayload(payload: string): NearIntentsPayloadFinding {
  return inspectNearIntentsPayload(payload, 0)
}

export function isNearIntentsSigningPayload(payload: string): boolean {
  return inspectNearIntentsSigningPayload(payload) !== 'clear'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function combineNearIntentsFindings(
  left: NearIntentsPayloadFinding,
  right: NearIntentsPayloadFinding
): NearIntentsPayloadFinding {
  if (left === 'match' || right === 'match') return 'match'
  if (left === 'incomplete' || right === 'incomplete') return 'incomplete'
  return 'clear'
}

function containsInternalSignatureDomain(value: string): boolean {
  return INTERNAL_SIGNATURE_DOMAINS.some(domain => value.includes(domain))
}

function hasNearIntentsFields(value: Record<string, unknown>): boolean {
  return NEAR_INTENTS_FIELDS.every(field => Object.prototype.hasOwnProperty.call(value, field))
}

function inspectNearIntentsPayload(payload: string, depth: number): NearIntentsPayloadFinding {
  if (containsInternalSignatureDomain(payload)) return 'match'
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'clear'
  if (depth >= MAX_NEAR_INTENTS_JSON_DEPTH) return 'incomplete'
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return 'clear'
  }
  return inspectNearIntentsValue(parsed, depth)
}

function inspectNearIntentsValue(value: unknown, depth: number): NearIntentsPayloadFinding {
  if (typeof value === 'string') {
    if (containsInternalSignatureDomain(value)) return 'match'
    return inspectNearIntentsPayload(value, depth + 1)
  }
  if (Array.isArray(value)) {
    let finding: NearIntentsPayloadFinding = 'clear'
    for (const item of value) {
      finding = combineNearIntentsFindings(finding, inspectNearIntentsValue(item, depth))
      if (finding === 'match') return finding
    }
    return finding
  }
  if (!isRecord(value)) return 'clear'
  if (hasNearIntentsFields(value)) return 'match'
  let finding: NearIntentsPayloadFinding = 'clear'
  for (const [key, child] of Object.entries(value)) {
    if (containsInternalSignatureDomain(key)) return 'match'
    finding = combineNearIntentsFindings(finding, inspectNearIntentsValue(child, depth))
    if (finding === 'match') return finding
  }
  return finding
}
