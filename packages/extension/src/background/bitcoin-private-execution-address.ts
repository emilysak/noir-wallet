export interface BitcoinPrivateExecutionAddressRequest {
  readonly keyDomainId: string
  readonly accountId: string
  readonly chainId: string
}

export type BitcoinPrivateExecutionAddressReader = (
  request: BitcoinPrivateExecutionAddressRequest
) => Promise<string | undefined>

let reader: BitcoinPrivateExecutionAddressReader | undefined

// The account-network catalog owns derivation. This reader only observes the
// address another component has already exposed.
export function setBitcoinPrivateExecutionAddressReader(
  next: BitcoinPrivateExecutionAddressReader | undefined
): void {
  reader = next
}

export async function readBitcoinPrivateExecutionAddress(
  request: BitcoinPrivateExecutionAddressRequest
): Promise<string | undefined> {
  if (!reader) return undefined
  try {
    const address = await reader(request)
    return typeof address === 'string' && address.length > 0 ? address : undefined
  } catch {
    return undefined
  }
}
