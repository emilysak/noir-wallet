import { test } from 'node:test'
import { expect } from '@playwright/test'
import { containsHiddenCharacters, revealHiddenCharacters } from '../../../src/lib/unicode-display'

test.describe('hidden character display', () => {
  test('reveals bidirectional controls and zero-width characters', () => {
    expect(revealHiddenCharacters('a\u202Eb')).toBe('a[U+202E]b')
    expect(revealHiddenCharacters('a\u202Ab')).toBe('a[U+202A]b')
    expect(revealHiddenCharacters('a\u2066b')).toBe('a[U+2066]b')
    expect(revealHiddenCharacters('a\u200Bb')).toBe('a[U+200B]b')
    expect(revealHiddenCharacters('a\u200Cc')).toBe('a[U+200C]c')
    expect(revealHiddenCharacters('a\u200Dd')).toBe('a[U+200D]d')
    expect(revealHiddenCharacters('a\u200Ee')).toBe('a[U+200E]e')
    expect(revealHiddenCharacters('a\u200Ff')).toBe('a[U+200F]f')
    expect(revealHiddenCharacters('a\u2060b')).toBe('a[U+2060]b')
    expect(revealHiddenCharacters('a\uFEFFb')).toBe('a[U+FEFF]b')
    expect(containsHiddenCharacters('\u202E')).toBe(true)
    expect(containsHiddenCharacters('\uFEFF')).toBe(true)
  })

  test('keeps newlines and ordinary text unchanged', () => {
    const text = 'Hello\n你好'
    expect(revealHiddenCharacters(text)).toBe(text)
    expect(containsHiddenCharacters(text)).toBe(false)
    expect(containsHiddenCharacters('pay [U+202E] now')).toBe(false)
  })
})
