export const HTTP_SIGNATURE_WARNING =
  'This site is using an insecure HTTP connection. Review this signature carefully.'

export type HttpSignatureSubject = 'message' | 'transaction'

/** Message signatures from a canonical http origin warn. Transactions stay quiet. */
export function httpSignatureWarning(origin: string, subject: HttpSignatureSubject): string | null {
  if (subject !== 'message') return null
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 2048) return null
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (
    url.protocol !== 'http:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.origin !== origin
  ) {
    return null
  }
  return HTTP_SIGNATURE_WARNING
}
