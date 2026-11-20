/**
 * Bidirectional controls and zero-width characters that can hide or reorder text.
 * Newlines and other C0 controls stay intact so memos and messages keep their layout.
 */
const HIDDEN_CHARACTER = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u

export const SIGNATURE_HIDDEN_CHARACTER_WARNING =
  'Hidden characters are shown as [U+XXXX]. The signature still covers the original text.'

export const MEMO_HIDDEN_CHARACTER_WARNING = 'Hidden characters in this memo are shown as [U+XXXX].'

export const BROADCAST_MEMO_HIDDEN_CHARACTER_WARNING =
  'Hidden characters are shown as [U+XXXX]. Broadcast still uses the original memo.'

export const MEMO_DRAFT_HIDDEN_CHARACTER_WARNING =
  'This memo contains hidden characters. Broadcast still uses this original text.'

export const DEPOSIT_MEMO_HIDDEN_CHARACTER_WARNING =
  'Hidden characters are shown as [U+XXXX]. Copy uses the original payment memo.'

export function containsHiddenCharacters(value: string): boolean {
  return HIDDEN_CHARACTER.test(value)
}

/** Replaces hidden characters with visible code-point labels. The input is not mutated. */
export function revealHiddenCharacters(value: string): string {
  return value.replace(new RegExp(HIDDEN_CHARACTER.source, 'gu'), character => {
    const codePoint = character.codePointAt(0) ?? 0
    return `[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}]`
  })
}
