import { parseEvmAccountDelegationResult, type EvmAccountDelegationResult } from '@/core/chains/evm'

export async function readEvmAccountDelegation(
  walletId: string,
  accountId: string,
  signal: AbortSignal
): Promise<EvmAccountDelegationResult> {
  if (signal.aborted) throw abortError()
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'GET_EVM_ACCOUNT_DELEGATION',
    walletId,
    accountId
  })
  // The account page ignores a response that arrives after it has left.
  if (signal.aborted) throw abortError()
  return parseDelegationResponse(response)
}

function parseDelegationResponse(value: unknown): EvmAccountDelegationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid EVM delegation response')
  }
  const response = value as Record<string, unknown>
  if (
    typeof response.error === 'string' ||
    !Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    throw new Error('EVM delegation status unavailable')
  }
  return parseEvmAccountDelegationResult(response.result)
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}
