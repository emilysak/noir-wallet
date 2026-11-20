import {
  parsePermit2AllowanceResult,
  type Permit2AllowanceResult
} from '@/infrastructure/chains/evm/evm-permit2-allowances'

export async function readPermit2Allowances(
  walletId: string,
  accountId: string,
  signal: AbortSignal
): Promise<Permit2AllowanceResult> {
  if (signal.aborted) throw abortError()
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'GET_EVM_PERMIT2_ALLOWANCES',
    walletId,
    accountId
  })
  if (signal.aborted) throw abortError()
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new Error('Permit2 allowances unavailable')
  }
  const record = response as Record<string, unknown>
  if (typeof record.error === 'string' || !Object.prototype.hasOwnProperty.call(record, 'result')) {
    throw new Error('Permit2 allowances unavailable')
  }
  return parsePermit2AllowanceResult(record.result)
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}
