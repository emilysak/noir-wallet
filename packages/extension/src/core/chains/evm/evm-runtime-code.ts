const EMPTY_RUNTIME_CODE = '0x'

/**
 * Whether an eth_getCode result can run on a value transfer.
 * Only canonical empty code is an EOA. An EIP-7702 delegation designator
 * (0xef0100 || address) is runtime code. Any other result fails closed.
 */
export function evmBytecodeHasRuntimeCode(code: string): boolean {
  if (typeof code !== 'string') return true
  return code.toLowerCase() !== EMPTY_RUNTIME_CODE
}
