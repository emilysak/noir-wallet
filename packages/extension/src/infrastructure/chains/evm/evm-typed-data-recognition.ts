import type {
  EvmTypedDataSummary,
  EvmTypedDataValue
} from '../../../core/keyring/domain/signing-summary'
import {
  decodeEvmPermitReview,
  matchesTypedDataDigest,
  type EvmPermitReview
} from './evm-permit-review'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const NAMED_DOMAIN = ['name', 'version', 'chainId', 'verifyingContract']
const FLEXIBLE_DOMAIN = ['name', 'version', 'chainId', 'verifyingContract', 'salt']
const SAFE_DOMAIN = ['chainId', 'verifyingContract']
const BLUR_EXCHANGE = '0x000000000000ad05ccc4f10045630fb830b95127'
const INCH_ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65'
const COW_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41'
const SEAPORT_CONTRACTS: Readonly<Record<string, string>> = Object.freeze({
  '1.1': '0x00000000006c3852cbef3e08e8df289169ede581',
  '1.2': '0x00000000000006c7676171937c444f6bde3d6282',
  '1.3': '0x0000000000000ad24e80fd803c6ac37206a45f15',
  '1.4': '0x00000000000001ad428e4906ae43d8f9852d0dd6',
  '1.5': '0x00000000000000adc04c56bf30ac9d3c0aaf14dc',
  '1.6': '0x0000000000000068f116a894984e2db1123eb395'
})

export interface EvmEip3009Transfer {
  readonly variant: 'transfer' | 'receive'
  readonly from: string
  readonly to: string
  readonly valueRaw: string
  readonly validAfterRaw: string
  readonly validBeforeRaw: string
  readonly verifyingContract: string
}

export interface EvmEip3009Cancel {
  readonly authorizer: string
  readonly nonce: string
  readonly verifyingContract: string
}

export interface EvmSeaportItem {
  readonly side: 'offer' | 'consideration'
  readonly itemType: number
  readonly token: string
  readonly identifier: string
  readonly startAmount: string
  readonly endAmount: string
  readonly recipient?: string
}

export interface EvmSeaportOrder {
  readonly offerer: string
  readonly zone: string
  readonly orderType: number
  readonly startTimeRaw: string
  readonly endTimeRaw: string
  readonly items: readonly EvmSeaportItem[]
}

export interface EvmBlurOrder {
  readonly trader: string
  readonly side: number
  readonly collection: string
  readonly tokenId: string
  readonly amountRaw: string
  readonly paymentToken: string
  readonly priceRaw: string
  readonly listingTimeRaw: string
  readonly expirationTimeRaw: string
  readonly fees: readonly { readonly rate: string; readonly recipient: string }[]
}

export interface EvmReceiverOrder {
  readonly protocol: '1inch' | 'CoW Protocol'
  readonly account: string
  readonly receiver: string
  readonly receiverIsDefault: boolean
  readonly sellToken: string
  readonly buyToken: string
  readonly sellAmountRaw: string
  readonly buyAmountRaw: string
  readonly expiryRaw: string | null
}

export interface EvmSafeTx {
  readonly safe: string
  readonly to: string
  readonly valueRaw: string
  readonly operation: number
  readonly refundReceiver: string
  readonly nonce: string
}

export type EvmTypedDataRecognition =
  | { readonly kind: 'permit'; readonly permit: EvmPermitReview }
  | { readonly kind: 'eip3009-transfer'; readonly transfer: EvmEip3009Transfer }
  | { readonly kind: 'eip3009-cancel'; readonly cancel: EvmEip3009Cancel }
  | { readonly kind: 'seaport'; readonly order: EvmSeaportOrder }
  | { readonly kind: 'blur'; readonly order: EvmBlurOrder }
  | { readonly kind: 'receiver-order'; readonly order: EvmReceiverOrder }
  | { readonly kind: 'safe-tx'; readonly transaction: EvmSafeTx }

type TypedField = { readonly name: string; readonly type: string }

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function structFields(
  value: EvmTypedDataValue,
  typeName: string,
  names: readonly string[]
): readonly EvmTypedDataValue[] | null {
  if (
    value.kind !== 'struct' ||
    value.typeName !== typeName ||
    value.fields.length !== names.length ||
    value.fields.some((field, index) => field.name !== names[index])
  ) {
    return null
  }
  return value.fields.map(field => field.value)
}

function address(value: EvmTypedDataValue | undefined): string | null {
  return value?.kind === 'scalar' && value.solidityType === 'address' && ADDRESS.test(value.value)
    ? value.value
    : null
}

function unsigned(value: EvmTypedDataValue | undefined, bits: number): string | null {
  if (
    !value ||
    value.kind !== 'scalar' ||
    value.solidityType !== `uint${bits}` ||
    !DECIMAL.test(value.value) ||
    value.value.length > 78
  ) {
    return null
  }
  return BigInt(value.value) < 1n << BigInt(bits) ? value.value : null
}

function bytes32(value: EvmTypedDataValue | undefined): string | null {
  return value?.kind === 'scalar' && value.solidityType === 'bytes32' && BYTES32.test(value.value)
    ? value.value
    : null
}

function bytes(value: EvmTypedDataValue | undefined): string | null {
  return value?.kind === 'scalar' && value.solidityType === 'bytes' && BYTES.test(value.value)
    ? value.value
    : null
}

function bool(value: EvmTypedDataValue | undefined): boolean | null {
  if (!value || value.kind !== 'scalar' || value.solidityType !== 'bool') return null
  if (value.value === 'true') return true
  if (value.value === 'false') return false
  return null
}

function text(value: EvmTypedDataValue | undefined): string | null {
  return value?.kind === 'scalar' && value.solidityType === 'string' ? value.value : null
}

function readDomain(
  summary: EvmTypedDataSummary,
  expectedFields: readonly string[],
  exact: boolean
): {
  readonly contract: string
  readonly name: string | null
  readonly version: string | null
} | null {
  const { domain } = summary.fields
  if (domain.kind !== 'struct' || domain.typeName !== 'EIP712Domain') return null
  const names = domain.fields.map(field => field.name)
  if (new Set(names).size !== names.length) return null
  const ordered = exact
    ? names.join('|') === expectedFields.join('|')
    : names.every(name => expectedFields.includes(name)) &&
      names.join('|') === expectedFields.filter(name => names.includes(name)).join('|') &&
      names.includes('chainId') &&
      names.includes('verifyingContract')
  if (!ordered) return null
  const values = new Map(domain.fields.map(field => [field.name, field.value]))
  const chainId = unsigned(values.get('chainId'), 256)
  const contract = address(values.get('verifyingContract'))
  if (chainId === null || !contract || summary.chainId !== `eip155:${chainId}`) return null
  const nameValue = values.get('name')
  const versionValue = values.get('version')
  if (nameValue && text(nameValue) === null) return null
  if (versionValue && text(versionValue) === null) return null
  const salt = values.get('salt')
  if (salt && !bytes32(salt)) return null
  return { contract, name: text(nameValue), version: text(versionValue) }
}

function messageOf(summary: EvmTypedDataSummary, primaryType: string): EvmTypedDataValue | null {
  const message = summary.fields.message
  if (
    summary.fields.primaryType !== primaryType ||
    message.kind !== 'struct' ||
    message.typeName !== primaryType
  ) {
    return null
  }
  return message
}

function structItems<T>(
  value: EvmTypedDataValue | undefined,
  itemType: string,
  decode: (value: EvmTypedDataValue) => T | null
): readonly T[] | null {
  if (!value || value.kind !== 'array' || value.itemType !== itemType) return null
  const items = value.items.map(decode)
  return items.every((item): item is T => item !== null) ? items : null
}

function signedBy(summary: EvmTypedDataSummary, account: string | null): account is string {
  return account !== null && sameAddress(account, summary.fields.signer)
}

const TRANSFER_AUTHORIZATION: readonly TypedField[] = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' }
]

function decodeEip3009(summary: EvmTypedDataSummary): EvmTypedDataRecognition | null {
  const domain = readDomain(summary, FLEXIBLE_DOMAIN, false)
  if (!domain) return null
  const primaryType = summary.fields.primaryType
  if (primaryType === 'CancelAuthorization') {
    const message = messageOf(summary, primaryType)
    if (!message) return null
    const cancel = structFields(message, primaryType, ['authorizer', 'nonce'])
    if (!cancel) return null
    const authorizer = address(cancel[0])
    const nonce = bytes32(cancel[1])
    if (
      !signedBy(summary, authorizer) ||
      !nonce ||
      !matchesTypedDataDigest(summary, {
        CancelAuthorization: [
          { name: 'authorizer', type: 'address' },
          { name: 'nonce', type: 'bytes32' }
        ]
      })
    ) {
      return null
    }
    return {
      kind: 'eip3009-cancel',
      cancel: { authorizer, nonce, verifyingContract: domain.contract }
    }
  }
  if (primaryType !== 'TransferWithAuthorization' && primaryType !== 'ReceiveWithAuthorization') {
    return null
  }
  const message = messageOf(summary, primaryType)
  if (!message) return null
  const transfer = structFields(message, primaryType, [
    'from',
    'to',
    'value',
    'validAfter',
    'validBefore',
    'nonce'
  ])
  if (!transfer) return null
  const from = address(transfer[0])
  const to = address(transfer[1])
  const valueRaw = unsigned(transfer[2], 256)
  const validAfterRaw = unsigned(transfer[3], 256)
  const validBeforeRaw = unsigned(transfer[4], 256)
  if (
    !signedBy(summary, from) ||
    !to ||
    valueRaw === null ||
    validAfterRaw === null ||
    validBeforeRaw === null ||
    !bytes32(transfer[5]) ||
    !matchesTypedDataDigest(summary, { [primaryType]: TRANSFER_AUTHORIZATION })
  ) {
    return null
  }
  return {
    kind: 'eip3009-transfer',
    transfer: {
      variant: primaryType === 'ReceiveWithAuthorization' ? 'receive' : 'transfer',
      from,
      to,
      valueRaw,
      validAfterRaw,
      validBeforeRaw,
      verifyingContract: domain.contract
    }
  }
}

const OFFER_FIELDS = [
  'itemType',
  'token',
  'identifierOrCriteria',
  'startAmount',
  'endAmount'
] as const

function seaportItem(
  value: EvmTypedDataValue,
  typeName: 'OfferItem' | 'ConsiderationItem'
): EvmSeaportItem | null {
  const names = typeName === 'OfferItem' ? OFFER_FIELDS : ([...OFFER_FIELDS, 'recipient'] as const)
  const item = structFields(value, typeName, names)
  if (!item) return null
  const itemType = unsigned(item[0], 8)
  const token = address(item[1])
  const identifier = unsigned(item[2], 256)
  const startAmount = unsigned(item[3], 256)
  const endAmount = unsigned(item[4], 256)
  const recipient = typeName === 'ConsiderationItem' ? address(item[5]) : null
  if (
    itemType === null ||
    !token ||
    identifier === null ||
    startAmount === null ||
    endAmount === null ||
    (typeName === 'ConsiderationItem' && !recipient)
  ) {
    return null
  }
  return {
    side: typeName === 'OfferItem' ? 'offer' : 'consideration',
    itemType: Number(itemType),
    token,
    identifier,
    startAmount,
    endAmount,
    ...(recipient ? { recipient } : {})
  }
}

const SEAPORT_TYPES: Readonly<Record<string, readonly TypedField[]>> = {
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' }
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' }
  ],
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' }
  ]
}

function decodeSeaport(summary: EvmTypedDataSummary): EvmTypedDataRecognition | null {
  const message = messageOf(summary, 'OrderComponents')
  const domain = readDomain(summary, NAMED_DOMAIN, true)
  if (!message || !domain || domain.name !== 'Seaport') return null
  const expectedContract = domain.version ? SEAPORT_CONTRACTS[domain.version] : undefined
  if (!expectedContract || !sameAddress(domain.contract, expectedContract)) return null
  const order = structFields(message, 'OrderComponents', [
    'offerer',
    'zone',
    'offer',
    'consideration',
    'orderType',
    'startTime',
    'endTime',
    'zoneHash',
    'salt',
    'conduitKey',
    'counter'
  ])
  if (!order) return null
  const offerer = address(order[0])
  const zone = address(order[1])
  const offer = structItems(order[2], 'OfferItem', item => seaportItem(item, 'OfferItem'))
  const consideration = structItems(order[3], 'ConsiderationItem', item =>
    seaportItem(item, 'ConsiderationItem')
  )
  const orderType = unsigned(order[4], 8)
  const startTimeRaw = unsigned(order[5], 256)
  const endTimeRaw = unsigned(order[6], 256)
  if (
    !signedBy(summary, offerer) ||
    !zone ||
    !offer ||
    !consideration ||
    orderType === null ||
    startTimeRaw === null ||
    endTimeRaw === null ||
    !bytes32(order[7]) ||
    unsigned(order[8], 256) === null ||
    !bytes32(order[9]) ||
    unsigned(order[10], 256) === null ||
    !matchesTypedDataDigest(summary, SEAPORT_TYPES)
  ) {
    return null
  }
  return {
    kind: 'seaport',
    order: {
      offerer,
      zone,
      orderType: Number(orderType),
      startTimeRaw,
      endTimeRaw,
      items: [...offer, ...consideration]
    }
  }
}

function blurFee(
  value: EvmTypedDataValue
): { readonly rate: string; readonly recipient: string } | null {
  const fee = structFields(value, 'Fee', ['rate', 'recipient'])
  if (!fee) return null
  const rate = unsigned(fee[0], 16)
  const recipient = address(fee[1])
  return rate !== null && recipient ? { rate, recipient } : null
}

const BLUR_TYPES: Readonly<Record<string, readonly TypedField[]>> = {
  Fee: [
    { name: 'rate', type: 'uint16' },
    { name: 'recipient', type: 'address' }
  ],
  Order: [
    { name: 'trader', type: 'address' },
    { name: 'side', type: 'uint8' },
    { name: 'matchingPolicy', type: 'address' },
    { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'paymentToken', type: 'address' },
    { name: 'price', type: 'uint256' },
    { name: 'listingTime', type: 'uint256' },
    { name: 'expirationTime', type: 'uint256' },
    { name: 'fees', type: 'Fee[]' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraParams', type: 'bytes' },
    { name: 'nonce', type: 'uint256' }
  ]
}

function decodeBlur(summary: EvmTypedDataSummary): EvmTypedDataRecognition | null {
  const message = messageOf(summary, 'Order')
  const domain = readDomain(summary, NAMED_DOMAIN, true)
  if (
    !message ||
    !domain ||
    domain.name !== 'Blur Exchange' ||
    domain.version !== '1.0' ||
    !sameAddress(domain.contract, BLUR_EXCHANGE)
  ) {
    return null
  }
  const order = structFields(message, 'Order', [
    'trader',
    'side',
    'matchingPolicy',
    'collection',
    'tokenId',
    'amount',
    'paymentToken',
    'price',
    'listingTime',
    'expirationTime',
    'fees',
    'salt',
    'extraParams',
    'nonce'
  ])
  if (!order) return null
  const trader = address(order[0])
  const side = unsigned(order[1], 8)
  const collection = address(order[3])
  const tokenId = unsigned(order[4], 256)
  const amountRaw = unsigned(order[5], 256)
  const paymentToken = address(order[6])
  const priceRaw = unsigned(order[7], 256)
  const listingTimeRaw = unsigned(order[8], 256)
  const expirationTimeRaw = unsigned(order[9], 256)
  const fees = structItems(order[10], 'Fee', blurFee)
  if (
    !signedBy(summary, trader) ||
    side === null ||
    !address(order[2]) ||
    !collection ||
    tokenId === null ||
    amountRaw === null ||
    !paymentToken ||
    priceRaw === null ||
    listingTimeRaw === null ||
    expirationTimeRaw === null ||
    !fees ||
    unsigned(order[11], 256) === null ||
    !bytes(order[12]) ||
    unsigned(order[13], 256) === null ||
    !matchesTypedDataDigest(summary, BLUR_TYPES)
  ) {
    return null
  }
  return {
    kind: 'blur',
    order: {
      trader,
      side: Number(side),
      collection,
      tokenId,
      amountRaw,
      paymentToken,
      priceRaw,
      listingTimeRaw,
      expirationTimeRaw,
      fees
    }
  }
}

const INCH_TYPES: Readonly<Record<string, readonly TypedField[]>> = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'makerAsset', type: 'address' },
    { name: 'takerAsset', type: 'address' },
    { name: 'makingAmount', type: 'uint256' },
    { name: 'takingAmount', type: 'uint256' },
    { name: 'makerTraits', type: 'uint256' }
  ]
}

const COW_TYPES: Readonly<Record<string, readonly TypedField[]>> = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'bytes32' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'bytes32' },
    { name: 'buyTokenBalance', type: 'bytes32' }
  ]
}

function decodeInch(summary: EvmTypedDataSummary): EvmReceiverOrder | null {
  const message = messageOf(summary, 'Order')
  const domain = readDomain(summary, NAMED_DOMAIN, true)
  if (
    !message ||
    !domain ||
    domain.name !== '1inch Aggregation Router' ||
    domain.version !== '6' ||
    !sameAddress(domain.contract, INCH_ROUTER)
  ) {
    return null
  }
  const order = structFields(message, 'Order', [
    'salt',
    'maker',
    'receiver',
    'makerAsset',
    'takerAsset',
    'makingAmount',
    'takingAmount',
    'makerTraits'
  ])
  if (!order) return null
  const maker = address(order[1])
  const receiver = address(order[2])
  const sellToken = address(order[3])
  const buyToken = address(order[4])
  const sellAmountRaw = unsigned(order[5], 256)
  const buyAmountRaw = unsigned(order[6], 256)
  if (
    !signedBy(summary, maker) ||
    !receiver ||
    !sellToken ||
    !buyToken ||
    sellAmountRaw === null ||
    buyAmountRaw === null ||
    unsigned(order[0], 256) === null ||
    unsigned(order[7], 256) === null ||
    !matchesTypedDataDigest(summary, INCH_TYPES)
  ) {
    return null
  }
  return {
    protocol: '1inch',
    account: maker,
    receiver,
    receiverIsDefault: sameAddress(receiver, ZERO_ADDRESS),
    sellToken,
    buyToken,
    sellAmountRaw,
    buyAmountRaw,
    expiryRaw: null
  }
}

function decodeCow(summary: EvmTypedDataSummary): EvmReceiverOrder | null {
  const message = messageOf(summary, 'Order')
  const domain = readDomain(summary, NAMED_DOMAIN, true)
  if (
    !message ||
    !domain ||
    domain.name !== 'Gnosis Protocol' ||
    domain.version !== 'v2' ||
    !sameAddress(domain.contract, COW_SETTLEMENT)
  ) {
    return null
  }
  const order = structFields(message, 'Order', [
    'sellToken',
    'buyToken',
    'receiver',
    'sellAmount',
    'buyAmount',
    'validTo',
    'appData',
    'feeAmount',
    'kind',
    'partiallyFillable',
    'sellTokenBalance',
    'buyTokenBalance'
  ])
  if (!order) return null
  const sellToken = address(order[0])
  const buyToken = address(order[1])
  const receiver = address(order[2])
  const sellAmountRaw = unsigned(order[3], 256)
  const buyAmountRaw = unsigned(order[4], 256)
  const expiryRaw = unsigned(order[5], 32)
  if (
    !sellToken ||
    !buyToken ||
    !receiver ||
    sellAmountRaw === null ||
    buyAmountRaw === null ||
    expiryRaw === null ||
    !bytes32(order[6]) ||
    unsigned(order[7], 256) === null ||
    !bytes32(order[8]) ||
    bool(order[9]) === null ||
    !bytes32(order[10]) ||
    !bytes32(order[11]) ||
    !matchesTypedDataDigest(summary, COW_TYPES)
  ) {
    return null
  }
  return {
    protocol: 'CoW Protocol',
    account: summary.fields.signer,
    receiver,
    receiverIsDefault: sameAddress(receiver, ZERO_ADDRESS),
    sellToken,
    buyToken,
    sellAmountRaw,
    buyAmountRaw,
    expiryRaw
  }
}

function decodeReceiverOrder(summary: EvmTypedDataSummary): EvmTypedDataRecognition | null {
  const order = decodeInch(summary) ?? decodeCow(summary)
  return order ? { kind: 'receiver-order', order } : null
}

const SAFE_TYPES: Readonly<Record<string, readonly TypedField[]>> = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' }
  ]
}

function decodeSafeTx(summary: EvmTypedDataSummary): EvmTypedDataRecognition | null {
  const message = messageOf(summary, 'SafeTx')
  const domain = readDomain(summary, SAFE_DOMAIN, true)
  if (!message || !domain) return null
  const transaction = structFields(message, 'SafeTx', [
    'to',
    'value',
    'data',
    'operation',
    'safeTxGas',
    'baseGas',
    'gasPrice',
    'gasToken',
    'refundReceiver',
    'nonce'
  ])
  if (!transaction) return null
  const to = address(transaction[0])
  const valueRaw = unsigned(transaction[1], 256)
  const operation = unsigned(transaction[3], 8)
  const refundReceiver = address(transaction[8])
  const nonce = unsigned(transaction[9], 256)
  if (
    !to ||
    valueRaw === null ||
    !bytes(transaction[2]) ||
    operation === null ||
    unsigned(transaction[4], 256) === null ||
    unsigned(transaction[5], 256) === null ||
    unsigned(transaction[6], 256) === null ||
    !address(transaction[7]) ||
    !refundReceiver ||
    nonce === null ||
    !matchesTypedDataDigest(summary, SAFE_TYPES)
  ) {
    return null
  }
  return {
    kind: 'safe-tx',
    transaction: {
      safe: domain.contract,
      to,
      valueRaw,
      operation: Number(operation),
      refundReceiver,
      nonce
    }
  }
}

export function decodeEvmTypedDataRecognition(
  summary: EvmTypedDataSummary
): EvmTypedDataRecognition | null {
  if (summary.schema !== 'evm.typed-data.v1' || summary.operation !== 'message') return null
  if (!ADDRESS.test(summary.fields.signer)) return null
  const permit = decodeEvmPermitReview(summary)
  if (permit) return { kind: 'permit', permit }
  return (
    decodeEip3009(summary) ??
    decodeSeaport(summary) ??
    decodeBlur(summary) ??
    decodeReceiverOrder(summary) ??
    decodeSafeTx(summary)
  )
}
