import { parseNearAccountId } from '@/core/chains/near'
import type { NearAddTokenAsset } from '@/popup/services/add-token-model'

import { parseNearFungibleTokenDisplay } from '@/infrastructure/chains/near/near-ft-metadata'
import {
  nearCustomTokenAssetId,
  nearCustomTokenStore,
  type NearCustomTokenRecord
} from '@/infrastructure/chains/near/near-custom-tokens'

type RuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

export class NearCustomTokenClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NearCustomTokenClientError'
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NearCustomTokenClientError(`Invalid ${label}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NearCustomTokenClientError(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function unwrap(value: unknown): unknown {
  const response = readRecord(value, 'NEAR token response')
  if (Object.prototype.hasOwnProperty.call(response, 'error')) {
    if (Object.keys(response).length !== 1 || typeof response.error !== 'string') {
      throw new NearCustomTokenClientError('Invalid NEAR token error')
    }
    throw new NearCustomTokenClientError(response.error)
  }
  if (
    Object.keys(response).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    throw new NearCustomTokenClientError('Invalid NEAR token response')
  }
  return response.result
}

function parseInspectedToken(
  value: unknown,
  requestedChainId: string,
  requestedContractId: string
): NearAddTokenAsset {
  const record = readRecord(value, 'NEAR token metadata')
  if (
    Object.keys(record).length !== 5 ||
    record.chainId !== requestedChainId ||
    typeof record.contractId !== 'string' ||
    record.contractId !== requestedContractId
  ) {
    throw new NearCustomTokenClientError(
      'This contract did not return valid NEP-141 token metadata.'
    )
  }
  let display: ReturnType<typeof parseNearFungibleTokenDisplay>
  try {
    display = parseNearFungibleTokenDisplay(record.name, record.symbol, record.decimals)
    if (
      parseNearAccountId(record.contractId, 'NEAR token contract account') !== requestedContractId
    ) {
      throw new Error('Invalid NEAR token contract account')
    }
  } catch {
    throw new NearCustomTokenClientError(
      'This contract did not return valid NEP-141 token metadata.'
    )
  }
  const assetId = nearCustomTokenAssetId(record.chainId, requestedContractId)
  return Object.freeze({
    assetId,
    chainId: record.chainId,
    contractId: requestedContractId,
    name: display.name,
    symbol: display.symbol,
    decimals: display.decimals
  })
}

async function refreshNearPortfolio(chainId: string): Promise<void> {
  await chrome.runtime
    .sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh', chainIds: [chainId] })
    .catch(() => undefined)
}

export function createNearCustomTokenClient(sendMessage: RuntimeMessenger) {
  return Object.freeze({
    inspect: async (input: {
      readonly chainId: string
      readonly contractId: string
    }): Promise<NearAddTokenAsset> => {
      let contractId: string
      try {
        contractId = parseNearAccountId(input.contractId, 'NEAR token contract account')
      } catch {
        throw new NearCustomTokenClientError('Enter a valid NEAR token contract account.')
      }
      return parseInspectedToken(
        unwrap(
          await sendMessage({
            type: 'INSPECT_USER_NEAR_ASSET',
            chainId: input.chainId,
            contractId
          })
        ),
        input.chainId,
        contractId
      )
    },
    list: (scope: {
      readonly walletId: string
      readonly accountId: string
    }): Promise<readonly NearCustomTokenRecord[]> => nearCustomTokenStore.list(scope),
    add: async (input: {
      readonly walletId: string
      readonly accountId: string
      readonly token: NearAddTokenAsset
    }): Promise<NearCustomTokenRecord> => {
      const record = await nearCustomTokenStore.upsert({
        walletId: input.walletId,
        accountId: input.accountId,
        chainId: input.token.chainId,
        contractId: input.token.contractId,
        name: input.token.name,
        symbol: input.token.symbol,
        decimals: input.token.decimals
      })
      await refreshNearPortfolio(record.chainId)
      return record
    },
    setHidden: async (input: {
      readonly walletId: string
      readonly accountId: string
      readonly contractId: string
      readonly hidden: boolean
    }): Promise<NearCustomTokenRecord> => {
      const record = await nearCustomTokenStore.setHidden(input, input.hidden)
      await refreshNearPortfolio(record.chainId)
      return record
    },
    remove: async (input: {
      readonly walletId: string
      readonly accountId: string
      readonly contractId: string
      readonly chainId: string
    }): Promise<void> => {
      await nearCustomTokenStore.remove(input)
      await refreshNearPortfolio(input.chainId)
    }
  })
}

export const nearCustomTokenClient = createNearCustomTokenClient(message =>
  chrome.runtime.sendMessage(message)
)
