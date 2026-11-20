import type { SigningReviewIssue } from '@/core/keyring/domain/signing-summary'

export const PERMIT2_CONTRACT = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_UINT160 = (1n << 160n) - 1n
const PERMIT2_LOCKDOWN_SELECTOR = 'cc53287f'
const MAX_PERMIT2_LOCKDOWN_PAIRS = 16

export const PERMIT2_TOKEN_REVOKE_EFFECT =
  'Revoking this stops Permit2 from moving this token. Signature transfers stop too. Allowances stored inside Permit2 stay in place and can be used again if you approve Permit2 later. Lock down each spender to clear those stored allowances.'

export const PERMIT2_LOCKDOWN_EFFECT =
  "This sets the stored Permit2 allowance amount and expiration to zero. The token's approval of Permit2 stays in place, so signature transfers can still spend the token."

export type Erc20CalldataRequest =
  | { readonly kind: 'approve'; readonly spender: string; readonly amountRaw: string }
  | { readonly kind: 'transfer'; readonly recipient: string; readonly amountRaw: string }
  | {
      readonly kind: 'transferFrom'
      readonly sender: string
      readonly recipient: string
      readonly amountRaw: string
    }

export type EvmAuthorizationCall =
  | {
      readonly kind: 'erc20-approve'
      readonly spender: string
      readonly amountRaw: string
      readonly unlimited: boolean
    }
  | {
      readonly kind: 'erc20-increase-allowance'
      readonly spender: string
      readonly amountRaw: string
    }
  | {
      readonly kind: 'erc20-decrease-allowance'
      readonly spender: string
      readonly amountRaw: string
    }
  | {
      readonly kind: 'erc721-set-approval-for-all'
      readonly operator: string
      readonly approved: boolean
    }
  | {
      readonly kind: 'permit2-approve'
      readonly token: string
      readonly spender: string
      readonly amountRaw: string
      readonly expirationRaw: string
      readonly unlimited: boolean
    }
  | {
      readonly kind: 'permit2-lockdown'
      readonly pairs: readonly { readonly token: string; readonly spender: string }[]
    }

const SELECTOR_ARGUMENTS: Readonly<Record<string, number>> = Object.freeze({
  '095ea7b3': 2,
  '39509351': 2,
  a457c2d7: 2,
  a9059cbb: 2,
  '23b872dd': 3,
  a22cb465: 2,
  '87517c45': 4
})

function decodeAddress(word: string): string | null {
  return /^0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(24)}` : null
}

function decodeBool(word: string): boolean | null {
  if (!/^[0-9a-f]{64}$/.test(word)) return null
  const value = BigInt(`0x${word}`)
  return value === 0n ? false : value === 1n ? true : null
}

function canonicalCalldataWords(value: string | undefined): readonly string[] | null {
  if (!value || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) return null
  const hex = value.slice(2).toLowerCase()
  const selector = hex.slice(0, 8)
  const argumentCount = SELECTOR_ARGUMENTS[selector]
  if (!argumentCount || hex.length !== 8 + argumentCount * 64) return null
  return Array.from({ length: argumentCount }, (_, index) =>
    hex.slice(8 + index * 64, 8 + (index + 1) * 64)
  )
}

function decodePermit2Lockdown(
  value: string | undefined,
  contractAddress: string | null | undefined
): Extract<EvmAuthorizationCall, { kind: 'permit2-lockdown' }> | null {
  if (
    contractAddress === null ||
    contractAddress === undefined ||
    contractAddress.toLowerCase() !== PERMIT2_CONTRACT ||
    !value ||
    !/^0x(?:[0-9a-f]{2})+$/i.test(value)
  ) {
    return null
  }
  const hex = value.slice(2).toLowerCase()
  if (!hex.startsWith(PERMIT2_LOCKDOWN_SELECTOR) || hex.length % 64 !== 8) return null
  const words = Array.from({ length: (hex.length - 8) / 64 }, (_, index) =>
    hex.slice(8 + index * 64, 8 + (index + 1) * 64)
  )
  // lockdown((address,address)[]) is one dynamic argument at the canonical offset.
  if (words.length < 4 || words[0] !== `${'0'.repeat(62)}20`) return null
  const length = BigInt(`0x${words[1]}`)
  if (length < 1n || length > BigInt(MAX_PERMIT2_LOCKDOWN_PAIRS)) return null
  if (words.length !== 2 + Number(length) * 2) return null
  const pairs = []
  for (let index = 0; index < Number(length); index += 1) {
    const token = decodeAddress(words[2 + index * 2]!)
    const spender = decodeAddress(words[3 + index * 2]!)
    if (!token || !spender) return null
    pairs.push(Object.freeze({ token, spender }))
  }
  return Object.freeze({ kind: 'permit2-lockdown', pairs: Object.freeze(pairs) })
}

export function decodeEvmAuthorizationCall(
  value: string | undefined,
  contractAddress: string | null | undefined
): EvmAuthorizationCall | null {
  const lockdown = decodePermit2Lockdown(value, contractAddress)
  if (lockdown) return lockdown
  if (
    value &&
    contractAddress &&
    value.slice(2, 10).toLowerCase() === PERMIT2_LOCKDOWN_SELECTOR &&
    contractAddress.toLowerCase() === PERMIT2_CONTRACT
  ) {
    return null
  }
  const words = canonicalCalldataWords(value)
  if (!words) return null
  const hex = value!.slice(2).toLowerCase()
  const selector = hex.slice(0, 8)

  if (selector === '095ea7b3') {
    const spender = decodeAddress(words[0]!)
    if (!spender) return null
    const amountRaw = BigInt(`0x${words[1]}`).toString()
    return {
      kind: 'erc20-approve',
      spender,
      amountRaw,
      // Unlimited is exact equality with the uint256 maximum, 2^256−1.
      unlimited: BigInt(amountRaw) === MAX_UINT256
    }
  }

  if (selector === '39509351') {
    const spender = decodeAddress(words[0]!)
    if (!spender) return null
    return {
      kind: 'erc20-increase-allowance',
      spender,
      amountRaw: BigInt(`0x${words[1]}`).toString()
    }
  }

  if (selector === 'a457c2d7') {
    const spender = decodeAddress(words[0]!)
    if (!spender) return null
    return {
      kind: 'erc20-decrease-allowance',
      spender,
      amountRaw: BigInt(`0x${words[1]}`).toString()
    }
  }

  if (selector === 'a22cb465') {
    const operator = decodeAddress(words[0]!)
    const approved = decodeBool(words[1]!)
    if (!operator || approved === null) return null
    return { kind: 'erc721-set-approval-for-all', operator, approved }
  }

  if (
    selector === '87517c45' &&
    contractAddress !== null &&
    contractAddress !== undefined &&
    contractAddress.toLowerCase() === PERMIT2_CONTRACT
  ) {
    const token = decodeAddress(words[0]!)
    const spender = decodeAddress(words[1]!)
    if (!token || !spender) return null
    const amountRaw = BigInt(`0x${words[2]}`).toString()
    const expirationRaw = BigInt(`0x${words[3]}`).toString()
    return {
      kind: 'permit2-approve',
      token,
      spender,
      amountRaw,
      expirationRaw,
      // Permit2 allowances are uint160. Unlimited is exact equality with 2^160−1.
      unlimited: BigInt(amountRaw) === MAX_UINT160
    }
  }

  return null
}

export function isEvmAuthorizationCalldata(
  value: string | undefined,
  contractAddress?: string | null
): boolean {
  return decodeEvmAuthorizationCall(value, contractAddress) !== null
}

export type EvmAccountControlCall =
  | { readonly kind: 'transfer-ownership'; readonly account: string }
  | { readonly kind: 'renounce-ownership' }
  | { readonly kind: 'upgrade-to'; readonly implementation: string }
  | { readonly kind: 'change-admin'; readonly account: string }

const ACCOUNT_CONTROL_ARGUMENTS: Readonly<Record<string, number>> = Object.freeze({
  f2fde38b: 1,
  '715018a6': 0,
  '3659cfe6': 1,
  '8f283970': 1
})

/** Fixed-length ownership and proxy admin calls. These stay unrecognized-call in review issues. */
export function decodeEvmAccountControlCall(
  value: string | undefined
): EvmAccountControlCall | null {
  if (!value || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) return null
  const hex = value.slice(2).toLowerCase()
  const selector = hex.slice(0, 8)
  const argumentCount = ACCOUNT_CONTROL_ARGUMENTS[selector]
  if (argumentCount === undefined || hex.length !== 8 + argumentCount * 64) return null
  if (selector === '715018a6') return { kind: 'renounce-ownership' }

  const account = decodeAddress(hex.slice(8, 72))
  if (!account) return null
  if (selector === 'f2fde38b') return { kind: 'transfer-ownership', account }
  if (selector === '3659cfe6') return { kind: 'upgrade-to', implementation: account }
  if (selector === '8f283970') return { kind: 'change-admin', account }
  return null
}

export function evmContractCallReviewIssues(
  calldata: string | undefined,
  contractAddress: string | null
): readonly SigningReviewIssue[] {
  const authorization = decodeEvmAuthorizationCall(calldata, contractAddress)
  if (!authorization) {
    return [Object.freeze({ code: 'unrecognized-call' as const })]
  }
  // Lockdown clears a stored allowance. It is not a new spending approval.
  if (authorization.kind === 'permit2-lockdown') return []
  const issues: SigningReviewIssue[] = [{ code: 'token-approval' }]
  if (
    (authorization.kind === 'erc20-approve' && authorization.unlimited) ||
    (authorization.kind === 'permit2-approve' && authorization.unlimited)
  ) {
    issues.push({ code: 'unlimited-token-approval' })
  }
  return issues.map(issue => Object.freeze(issue))
}

export function decodeErc20CalldataRequest(value: string | undefined): Erc20CalldataRequest | null {
  const words = canonicalCalldataWords(value)
  if (!words) return null
  const hex = value!.slice(2).toLowerCase()
  const selector = hex.slice(0, 8)
  if (selector === '23b872dd') {
    const sender = decodeAddress(words[0]!)
    const recipient = decodeAddress(words[1]!)
    if (!sender || !recipient) return null
    return {
      kind: 'transferFrom',
      sender,
      recipient,
      amountRaw: BigInt(`0x${words[2]}`).toString()
    }
  }
  const address = decodeAddress(words[0]!)
  if (!address) return null
  const amountRaw = BigInt(`0x${words[1]}`).toString()
  return selector === '095ea7b3'
    ? { kind: 'approve', spender: address, amountRaw }
    : { kind: 'transfer', recipient: address, amountRaw }
}

export function isErc20ApproveCalldata(value: string | undefined): boolean {
  return decodeErc20CalldataRequest(value)?.kind === 'approve'
}
