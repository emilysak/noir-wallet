import * as secp256k1 from '@bitcoinerlab/secp256k1'
import {
  address,
  crypto as bitcoinCrypto,
  initEccLib,
  networks,
  payments,
  Psbt,
  Transaction
} from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import type { DerivedBitcoinAddress } from '@/core/chains/bitcoin'
import {
  BITCOIN_MAINNET_CHAIN_ID,
  BITCOIN_MAXIMUM_SELECTION_UTXOS,
  bitcoinAccountRootFromPath,
  bitcoinDustSats,
  estimateBitcoinVbytes,
  failInvalidBitcoinTransaction,
  parseBitcoinAddress,
  parseBitcoinAddressType,
  parseBitcoinAmount,
  parseBitcoinChain,
  parseBitcoinFeeRate,
  parseBitcoinIndex,
  parseBitcoinMasterFingerprint,
  parseBitcoinPublicKey,
  type BitcoinChangeOutputPosition,
  type BitcoinCoinSelection,
  type BitcoinPreviousTransaction,
  type BitcoinSpendableUtxo,
  type BuildBitcoinPsbtInput,
  type PreparedBitcoinPsbt
} from './bitcoin-transaction-model'
import { parseBitcoinSpendableUtxo, sumBitcoinUtxos } from './bitcoin-spendable-utxos'

const BITCOIN_RBF_SEQUENCE = 0xfffffffd
const MAXIMUM_LOCK_TIME = 0x7fffffff

let eccInitialized = false

function ensureBitcoinEcc(): void {
  if (eccInitialized) return
  initEccLib(secp256k1)
  eccInitialized = true
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  return requiredKeys.every(key => keys.includes(key)) && keys.every(key => allowed.has(key))
}

function parseNonNegativeBitcoinAmount(value: unknown, label: string): bigint {
  if (value === '0') return 0n
  return parseBitcoinAmount(value, label)
}

function parseOptionalBitcoinScript(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(value)) {
    failInvalidBitcoinTransaction(`Invalid ${label}`)
  }
  return value
}

function bitcoinNetwork(chainId: BitcoinCoinSelection['chainId']) {
  return chainId === BITCOIN_MAINNET_CHAIN_ID ? networks.bitcoin : networks.testnet
}

function publicKeyBuffer(publicKey: string): Buffer {
  return Buffer.from(publicKey.slice(2), 'hex')
}

function xOnlyPublicKey(publicKey: string): Buffer {
  return publicKeyBuffer(publicKey).subarray(1, 33)
}

function paymentForPublicKey(
  publicKey: string,
  chainId: BitcoinCoinSelection['chainId'],
  addressType: BitcoinCoinSelection['addressType']
) {
  const network = bitcoinNetwork(chainId)
  const pubkey = publicKeyBuffer(publicKey)
  switch (addressType) {
    case 'p2pkh':
      return payments.p2pkh({ pubkey, network })
    case 'p2sh-p2wpkh':
      return payments.p2sh({ redeem: payments.p2wpkh({ pubkey, network }), network })
    case 'p2wpkh':
      return payments.p2wpkh({ pubkey, network })
    case 'p2tr':
      return payments.p2tr({ internalPubkey: xOnlyPublicKey(publicKey), network })
  }
}

function assertPublicKeyMatchesAddress(
  publicKey: string,
  expectedAddress: string,
  chainId: BitcoinCoinSelection['chainId'],
  addressType: BitcoinCoinSelection['addressType']
): void {
  const derivedAddress = paymentForPublicKey(publicKey, chainId, addressType).address
  if (derivedAddress !== expectedAddress) {
    failInvalidBitcoinTransaction('Bitcoin public key does not match its address')
  }
}

function parseCoinSelection(value: BitcoinCoinSelection): BitcoinCoinSelection {
  if (
    !hasExactKeys(value, [
      'chainId',
      'accountIndex',
      'addressType',
      'recipient',
      'recipientAddressType',
      'selectedUtxos',
      'selectedTotalSats',
      'amountSats',
      'feeSats',
      'changeSats',
      'estimatedVbytes',
      'feeRateSatsPerVbyte'
    ])
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin coin selection')
  }
  const chainId = parseBitcoinChain(value.chainId)
  const accountIndex = parseBitcoinIndex(value.accountIndex, 'Bitcoin account index')
  const addressType = parseBitcoinAddressType(value.addressType)
  const recipient = parseBitcoinAddress(value.recipient, chainId)
  const recipientAddressType = parseBitcoinAddressType(value.recipientAddressType)
  parseBitcoinAddress(recipient, chainId, recipientAddressType)
  const feeRateSatsPerVbyte = parseBitcoinFeeRate(value.feeRateSatsPerVbyte)
  if (
    !Array.isArray(value.selectedUtxos) ||
    value.selectedUtxos.length === 0 ||
    value.selectedUtxos.length > BITCOIN_MAXIMUM_SELECTION_UTXOS
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin selected UTXOs')
  }
  const seen = new Set<string>()
  let accountRoot: string | undefined
  const selectedUtxos = value.selectedUtxos.map(candidate => {
    const utxo = parseBitcoinSpendableUtxo(candidate)
    if (
      utxo.chainId !== chainId ||
      utxo.accountIndex !== accountIndex ||
      utxo.addressType !== addressType
    ) {
      failInvalidBitcoinTransaction('Bitcoin UTXO does not match the selected account')
    }
    const root = bitcoinAccountRootFromPath(
      utxo.derivationPath,
      chainId,
      addressType,
      utxo.change,
      utxo.addressIndex
    )
    if (accountRoot !== undefined && accountRoot !== root) {
      failInvalidBitcoinTransaction('Bitcoin UTXOs belong to different accounts')
    }
    accountRoot = root
    const outpoint = `${utxo.transactionId}:${utxo.outputIndex}`
    if (seen.has(outpoint)) failInvalidBitcoinTransaction('Duplicate Bitcoin UTXO')
    seen.add(outpoint)
    assertPublicKeyMatchesAddress(utxo.publicKey, utxo.address, chainId, addressType)
    return utxo
  })
  const selectedTotalSats = parseBitcoinAmount(value.selectedTotalSats, 'Bitcoin selected total')
  const amountSats = parseBitcoinAmount(value.amountSats, 'Bitcoin transfer amount')
  const feeSats = parseBitcoinAmount(value.feeSats, 'Bitcoin transaction fee')
  const changeSats = parseNonNegativeBitcoinAmount(value.changeSats, 'Bitcoin change amount')
  const expectedVbytes = estimateBitcoinVbytes(
    selectedUtxos.length,
    addressType,
    recipientAddressType,
    changeSats > 0n
  )
  if (
    !Number.isSafeInteger(value.estimatedVbytes) ||
    value.estimatedVbytes !== Number(expectedVbytes) ||
    sumBitcoinUtxos(selectedUtxos) !== selectedTotalSats ||
    amountSats + feeSats + changeSats !== selectedTotalSats ||
    amountSats < bitcoinDustSats(recipientAddressType) ||
    (changeSats > 0n && changeSats < bitcoinDustSats(addressType)) ||
    feeSats < expectedVbytes * BigInt(feeRateSatsPerVbyte) ||
    (changeSats > 0n && feeSats !== expectedVbytes * BigInt(feeRateSatsPerVbyte))
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin coin selection')
  }
  return Object.freeze({
    chainId,
    accountIndex,
    addressType,
    recipient,
    recipientAddressType,
    selectedUtxos: Object.freeze(selectedUtxos),
    selectedTotalSats: selectedTotalSats.toString(),
    amountSats: amountSats.toString(),
    feeSats: feeSats.toString(),
    changeSats: changeSats.toString(),
    estimatedVbytes: Number(expectedVbytes),
    feeRateSatsPerVbyte
  })
}

function parseChangeAddress(
  value: unknown,
  selection: BitcoinCoinSelection,
  masterFingerprint: string
): DerivedBitcoinAddress {
  if (
    !hasExactKeys(
      value,
      [
        'chainId',
        'addressType',
        'accountIndex',
        'change',
        'addressIndex',
        'address',
        'addressScheme',
        'derivationScheme',
        'derivationPath',
        'publicKey'
      ],
      ['masterFingerprint', 'scriptPubKey', 'redeemScript']
    )
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin change address')
  }
  if (typeof value.change !== 'boolean') {
    failInvalidBitcoinTransaction('Invalid Bitcoin change address branch')
  }
  const change = value.change
  const addressIndex = parseBitcoinIndex(value.addressIndex, 'Bitcoin change address index')
  if (!change && addressIndex !== 0) {
    failInvalidBitcoinTransaction('Bitcoin change address must be the active receive address')
  }
  const selectedRoot = bitcoinAccountRootFromPath(
    selection.selectedUtxos[0].derivationPath,
    selection.chainId,
    selection.addressType,
    selection.selectedUtxos[0].change,
    selection.selectedUtxos[0].addressIndex
  )
  const expectedPath = `${selectedRoot}/${change ? 1 : 0}/${addressIndex}`
  const profile =
    selection.addressType === 'p2pkh'
      ? ({ addressScheme: 'bitcoin-p2pkh', derivationScheme: 'bip44' } as const)
      : selection.addressType === 'p2sh-p2wpkh'
        ? ({ addressScheme: 'bitcoin-p2sh-p2wpkh', derivationScheme: 'bip49' } as const)
        : selection.addressType === 'p2wpkh'
          ? ({ addressScheme: 'bitcoin-p2wpkh', derivationScheme: 'bip84' } as const)
          : ({ addressScheme: 'bitcoin-p2tr', derivationScheme: 'bip86' } as const)
  if (
    value.chainId !== selection.chainId ||
    value.addressType !== selection.addressType ||
    value.accountIndex !== selection.accountIndex ||
    value.addressScheme !== profile.addressScheme ||
    value.derivationScheme !== profile.derivationScheme ||
    value.derivationPath !== expectedPath ||
    (value.masterFingerprint !== undefined &&
      parseBitcoinMasterFingerprint(value.masterFingerprint) !== masterFingerprint)
  ) {
    failInvalidBitcoinTransaction('Bitcoin change address does not match the selected account')
  }
  const publicKey = parseBitcoinPublicKey(value.publicKey)
  const payment = paymentForPublicKey(publicKey, selection.chainId, selection.addressType)
  const expectedScriptPubKey = payment.output ? `0x${payment.output.toString('hex')}` : null
  const expectedRedeemScript = payment.redeem?.output
    ? `0x${payment.redeem.output.toString('hex')}`
    : undefined
  const scriptPubKey = parseOptionalBitcoinScript(value.scriptPubKey, 'Bitcoin change scriptPubKey')
  const redeemScript = parseOptionalBitcoinScript(value.redeemScript, 'Bitcoin change redeemScript')
  if (
    expectedScriptPubKey === null ||
    (scriptPubKey !== undefined && scriptPubKey !== expectedScriptPubKey) ||
    ((selection.addressType === 'p2pkh' || selection.addressType === 'p2sh-p2wpkh') &&
      scriptPubKey === undefined) ||
    redeemScript !== expectedRedeemScript
  ) {
    failInvalidBitcoinTransaction('Bitcoin change address scripts do not match its public key')
  }
  const parsed = Object.freeze({
    chainId: selection.chainId,
    addressType: selection.addressType,
    accountIndex: selection.accountIndex,
    change,
    addressIndex,
    address: parseBitcoinAddress(value.address, selection.chainId, selection.addressType),
    addressScheme: profile.addressScheme,
    derivationScheme: profile.derivationScheme,
    derivationPath: expectedPath,
    publicKey,
    ...(value.masterFingerprint === undefined ? {} : { masterFingerprint }),
    ...(scriptPubKey === undefined ? {} : { scriptPubKey }),
    ...(redeemScript === undefined ? {} : { redeemScript })
  }) satisfies DerivedBitcoinAddress
  assertPublicKeyMatchesAddress(
    parsed.publicKey,
    parsed.address,
    selection.chainId,
    selection.addressType
  )
  return parsed
}

function keyOrigin(
  chainId: BitcoinCoinSelection['chainId'],
  addressType: BitcoinCoinSelection['addressType'],
  publicKey: string,
  derivationPath: string,
  masterFingerprint: Buffer
) {
  if (addressType !== 'p2tr') {
    const payment = paymentForPublicKey(publicKey, chainId, addressType)
    const redeemScript = payment.redeem?.output
    if (addressType === 'p2sh-p2wpkh' && !redeemScript) {
      failInvalidBitcoinTransaction('Bitcoin nested SegWit redeem script is unavailable')
    }
    return {
      bip32Derivation: [
        { masterFingerprint, pubkey: publicKeyBuffer(publicKey), path: derivationPath }
      ],
      ...(addressType === 'p2sh-p2wpkh'
        ? {
            redeemScript:
              redeemScript ??
              failInvalidBitcoinTransaction('Bitcoin nested SegWit redeem script is unavailable')
          }
        : {})
    }
  }
  const internalPublicKey = xOnlyPublicKey(publicKey)
  return {
    tapInternalKey: internalPublicKey,
    tapBip32Derivation: [
      {
        masterFingerprint,
        pubkey: internalPublicKey,
        path: derivationPath,
        leafHashes: []
      }
    ]
  }
}

function requiresPreviousTransaction(addressType: BitcoinCoinSelection['addressType']): boolean {
  return addressType !== 'p2tr'
}

function parsePreviousTransactions(
  value: unknown,
  selection: BitcoinCoinSelection
): ReadonlyMap<string, Transaction> {
  if (!requiresPreviousTransaction(selection.addressType)) {
    if (value !== undefined) {
      failInvalidBitcoinTransaction('Previous transactions are only valid for non-Taproot inputs')
    }
    return new Map()
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > BITCOIN_MAXIMUM_SELECTION_UTXOS
  ) {
    failInvalidBitcoinTransaction('Bitcoin inputs require previous transactions')
  }
  const transactions = new Map<string, Transaction>()
  for (const candidate of value) {
    if (!hasExactKeys(candidate, ['transactionId', 'rawTransactionHex'])) {
      failInvalidBitcoinTransaction('Invalid Bitcoin previous transaction')
    }
    if (
      typeof candidate.transactionId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(candidate.transactionId) ||
      typeof candidate.rawTransactionHex !== 'string' ||
      !/^(?:[0-9a-f]{2})+$/.test(candidate.rawTransactionHex) ||
      candidate.rawTransactionHex.length > 2 * 1024 * 1024
    ) {
      failInvalidBitcoinTransaction('Invalid Bitcoin previous transaction')
    }
    let transaction: Transaction
    try {
      transaction = Transaction.fromHex(candidate.rawTransactionHex)
    } catch {
      failInvalidBitcoinTransaction('Invalid Bitcoin previous transaction')
    }
    if (
      transaction.getId() !== candidate.transactionId ||
      transactions.has(candidate.transactionId)
    ) {
      failInvalidBitcoinTransaction('Bitcoin previous transaction does not match its ID')
    }
    transactions.set(candidate.transactionId, transaction)
  }
  const required = new Set(selection.selectedUtxos.map(utxo => utxo.transactionId))
  if (
    transactions.size !== required.size ||
    [...required].some(transactionId => !transactions.has(transactionId))
  ) {
    failInvalidBitcoinTransaction('Bitcoin previous transactions do not cover selected inputs')
  }
  return transactions
}

function addInput(
  psbt: Psbt,
  selection: BitcoinCoinSelection,
  utxo: BitcoinSpendableUtxo,
  masterFingerprint: Buffer,
  previousTransactions: ReadonlyMap<string, Transaction>
): void {
  const script = address.toOutputScript(utxo.address, bitcoinNetwork(selection.chainId))
  const origin = keyOrigin(
    selection.chainId,
    selection.addressType,
    utxo.publicKey,
    utxo.derivationPath,
    masterFingerprint
  )
  const previous = previousTransactions.get(utxo.transactionId)
  const output = previous?.outs[utxo.outputIndex]
  if (
    selection.addressType !== 'p2tr' &&
    (!previous ||
      !output ||
      output.value !== Number(BigInt(utxo.valueSats)) ||
      !output.script.equals(script))
  ) {
    failInvalidBitcoinTransaction('Bitcoin previous transaction output does not match discovery')
  }
  if (selection.addressType === 'p2pkh') {
    psbt.addInput({
      hash: utxo.transactionId,
      index: utxo.outputIndex,
      sequence: BITCOIN_RBF_SEQUENCE,
      nonWitnessUtxo: previous!.toBuffer(),
      ...origin
    })
    return
  }
  if (selection.addressType === 'p2wpkh' || selection.addressType === 'p2sh-p2wpkh') {
    psbt.addInput({
      hash: utxo.transactionId,
      index: utxo.outputIndex,
      sequence: BITCOIN_RBF_SEQUENCE,
      witnessUtxo: {
        script,
        value: Number(BigInt(utxo.valueSats))
      },
      nonWitnessUtxo: previous!.toBuffer(),
      ...origin
    })
    return
  }
  psbt.addInput({
    hash: utxo.transactionId,
    index: utxo.outputIndex,
    sequence: BITCOIN_RBF_SEQUENCE,
    witnessUtxo: {
      script,
      value: Number(BigInt(utxo.valueSats))
    },
    ...origin
  })
}

export function buildBitcoinPsbt(input: BuildBitcoinPsbtInput): PreparedBitcoinPsbt {
  ensureBitcoinEcc()
  const hasChange = hasExactKeys(
    input,
    ['selection', 'masterFingerprint', 'lockTime', 'change'],
    ['previousTransactions']
  )
  if (
    !hasChange &&
    !hasExactKeys(input, ['selection', 'masterFingerprint', 'lockTime'], ['previousTransactions'])
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin PSBT build input')
  }
  const selection = parseCoinSelection(input.selection)
  const masterFingerprintValue = parseBitcoinMasterFingerprint(input.masterFingerprint)
  const masterFingerprint = Buffer.from(masterFingerprintValue.slice(2), 'hex')
  const lockTime = parseBitcoinIndex(input.lockTime, 'Bitcoin lock time', MAXIMUM_LOCK_TIME)
  const previousTransactions = parsePreviousTransactions(input.previousTransactions, selection)
  const changeSats = BigInt(selection.changeSats)
  if (changeSats > 0n !== hasChange) {
    failInvalidBitcoinTransaction('Bitcoin change output does not match the coin selection')
  }

  let changeAddress: DerivedBitcoinAddress | null = null
  let changeOutputPosition: BitcoinChangeOutputPosition | null = null
  if (hasChange) {
    const changeInput =
      'change' in input
        ? input.change
        : failInvalidBitcoinTransaction('Invalid Bitcoin change output')
    if (!hasExactKeys(changeInput, ['address', 'outputPosition'])) {
      failInvalidBitcoinTransaction('Invalid Bitcoin change output')
    }
    if (changeInput.outputPosition !== 'first' && changeInput.outputPosition !== 'last') {
      failInvalidBitcoinTransaction('Invalid Bitcoin change output position')
    }
    changeAddress = parseChangeAddress(changeInput.address, selection, masterFingerprintValue)
    changeOutputPosition = changeInput.outputPosition
  }

  const psbt = new Psbt({ network: bitcoinNetwork(selection.chainId) })
  psbt.setVersion(2).setLocktime(lockTime)
  for (const utxo of selection.selectedUtxos) {
    addInput(psbt, selection, utxo, masterFingerprint, previousTransactions)
  }

  const recipientOutput = Object.freeze({
    address: selection.recipient,
    value: Number(BigInt(selection.amountSats))
  })
  const changeOutput =
    changeAddress === null
      ? null
      : Object.freeze({
          address: changeAddress.address,
          value: Number(changeSats),
          ...keyOrigin(
            selection.chainId,
            selection.addressType,
            changeAddress.publicKey,
            changeAddress.derivationPath,
            masterFingerprint
          )
        })
  if (changeOutputPosition === 'first' && changeOutput) psbt.addOutput(changeOutput)
  psbt.addOutput(recipientOutput)
  if (changeOutputPosition === 'last' && changeOutput) psbt.addOutput(changeOutput)

  const unsignedTransaction = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  const recipientOutputIndex = changeOutputPosition === 'first' ? 1 : 0
  const changeOutputIndex =
    changeOutputPosition === null ? null : changeOutputPosition === 'first' ? 0 : 1
  return Object.freeze({
    schemaVersion: 1,
    chainId: selection.chainId,
    accountIndex: selection.accountIndex,
    addressType: selection.addressType,
    psbtBase64: psbt.toBase64(),
    unsignedTransactionId: unsignedTransaction.getId(),
    transactionVersion: 2,
    lockTime,
    rbf: true,
    inputCount: selection.selectedUtxos.length,
    outputCount: changeOutput === null ? 1 : 2,
    recipient: selection.recipient,
    recipientOutputIndex,
    changeAddress: changeAddress?.address ?? null,
    changeOutputIndex,
    selectedTotalSats: selection.selectedTotalSats,
    amountSats: selection.amountSats,
    feeSats: selection.feeSats,
    changeSats: selection.changeSats,
    estimatedVbytes: selection.estimatedVbytes,
    feeRateSatsPerVbyte: selection.feeRateSatsPerVbyte
  })
}

export interface BuildBitcoinPrivateExecutionPsbtInput {
  readonly selection: BitcoinCoinSelection
  readonly publicKey: string
  readonly lockTime: number
  readonly previousTransactions: readonly BitcoinPreviousTransaction[]
  readonly privateExecutionAddress: string
  readonly publicReceiveAddress: string
  readonly changeOutputPosition: BitcoinChangeOutputPosition | null
}

function importedKeyFingerprint(publicKey: Buffer): Buffer {
  return bitcoinCrypto.hash160(publicKey).subarray(0, 4)
}

function importedKeyOrigin(publicKey: string, fingerprint: Buffer) {
  return {
    bip32Derivation: [
      {
        masterFingerprint: fingerprint,
        pubkey: publicKeyBuffer(publicKey),
        path: 'm'
      }
    ]
  }
}

export function buildBitcoinPrivateExecutionPsbt(
  input: BuildBitcoinPrivateExecutionPsbtInput
): PreparedBitcoinPsbt {
  ensureBitcoinEcc()
  if (
    !hasExactKeys(input, [
      'selection',
      'publicKey',
      'lockTime',
      'previousTransactions',
      'privateExecutionAddress',
      'publicReceiveAddress',
      'changeOutputPosition'
    ])
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin private execution PSBT input')
  }
  const selection = input.selection
  if (selection.addressType !== 'p2wpkh') {
    failInvalidBitcoinTransaction('Bitcoin private execution spends Native SegWit')
  }
  const privateExecutionAddress = parseBitcoinAddress(
    input.privateExecutionAddress,
    selection.chainId,
    'p2wpkh'
  )
  const publicReceiveAddress = parseBitcoinAddress(input.publicReceiveAddress, selection.chainId)
  if (privateExecutionAddress === publicReceiveAddress) {
    failInvalidBitcoinTransaction('Bitcoin private execution address is unavailable')
  }
  if (selection.recipient === publicReceiveAddress) {
    failInvalidBitcoinTransaction('Bitcoin private transfer cannot pay the public address')
  }
  const publicKey = parseBitcoinPublicKey(input.publicKey)
  assertPublicKeyMatchesAddress(publicKey, privateExecutionAddress, selection.chainId, 'p2wpkh')
  const changeSats = BigInt(selection.changeSats)
  const changeOutputPosition = input.changeOutputPosition
  if (
    (changeSats > 0n && changeOutputPosition !== 'first' && changeOutputPosition !== 'last') ||
    (changeSats === 0n && changeOutputPosition !== null)
  ) {
    failInvalidBitcoinTransaction('Bitcoin change output does not match the coin selection')
  }
  const network = bitcoinNetwork(selection.chainId)
  const privateScript = address.toOutputScript(privateExecutionAddress, network)
  const publicScript = address.toOutputScript(publicReceiveAddress, network)
  if (privateScript.equals(publicScript)) {
    failInvalidBitcoinTransaction('Bitcoin private execution address is unavailable')
  }
  const previousTransactions = new Map<string, Transaction>()
  if (
    !Array.isArray(input.previousTransactions) ||
    input.previousTransactions.length === 0 ||
    input.previousTransactions.length > BITCOIN_MAXIMUM_SELECTION_UTXOS
  ) {
    failInvalidBitcoinTransaction('Bitcoin private execution inputs require previous transactions')
  }
  for (const candidate of input.previousTransactions) {
    if (
      !hasExactKeys(candidate, ['transactionId', 'rawTransactionHex']) ||
      typeof candidate.transactionId !== 'string' ||
      typeof candidate.rawTransactionHex !== 'string'
    ) {
      failInvalidBitcoinTransaction('Invalid Bitcoin previous transaction')
    }
    let transaction: Transaction
    try {
      transaction = Transaction.fromHex(candidate.rawTransactionHex)
    } catch {
      failInvalidBitcoinTransaction('Invalid Bitcoin previous transaction')
    }
    if (
      transaction.getId() !== candidate.transactionId ||
      previousTransactions.has(candidate.transactionId)
    ) {
      failInvalidBitcoinTransaction('Bitcoin previous transaction does not match its ID')
    }
    previousTransactions.set(candidate.transactionId, transaction)
  }
  for (const utxo of selection.selectedUtxos) {
    if (utxo.address === publicReceiveAddress || utxo.address !== privateExecutionAddress) {
      failInvalidBitcoinTransaction(
        utxo.address === publicReceiveAddress
          ? 'Bitcoin private transfer cannot spend the public address'
          : 'Bitcoin private transfer input is not the private execution address'
      )
    }
    const previous = previousTransactions.get(utxo.transactionId)
    const output = previous?.outs[utxo.outputIndex]
    const spendsPublicAddress = Boolean(output && output.script.equals(publicScript))
    if (
      !previous ||
      !output ||
      output.value !== Number(BigInt(utxo.valueSats)) ||
      !output.script.equals(privateScript) ||
      spendsPublicAddress
    ) {
      failInvalidBitcoinTransaction(
        spendsPublicAddress
          ? 'Bitcoin private transfer cannot spend the public address'
          : 'Bitcoin private transfer input is not the private execution address'
      )
    }
  }

  const fingerprint = importedKeyFingerprint(publicKeyBuffer(publicKey))
  const origin = importedKeyOrigin(publicKey, fingerprint)
  const psbt = new Psbt({ network })
  psbt
    .setVersion(2)
    .setLocktime(parseBitcoinIndex(input.lockTime, 'Bitcoin lock time', MAXIMUM_LOCK_TIME))
  for (const utxo of selection.selectedUtxos) {
    const previous = previousTransactions.get(utxo.transactionId)
    if (!previous) {
      failInvalidBitcoinTransaction(
        'Bitcoin private transfer input is not the private execution address'
      )
    }
    // preparePeaBitcoinPsbt signs this as an imported key. A BIP84 origin is
    // rejected, and a P2WPKH input without the full previous transaction is too.
    psbt.addInput({
      hash: utxo.transactionId,
      index: utxo.outputIndex,
      sequence: BITCOIN_RBF_SEQUENCE,
      nonWitnessUtxo: previous.toBuffer(),
      witnessUtxo: {
        script: privateScript,
        value: Number(BigInt(utxo.valueSats))
      },
      ...origin
    })
  }
  const recipientOutput = Object.freeze({
    address: selection.recipient,
    value: Number(BigInt(selection.amountSats))
  })
  const changeOutput =
    changeSats === 0n
      ? null
      : Object.freeze({
          address: privateExecutionAddress,
          value: Number(changeSats),
          ...origin
        })
  if (changeOutputPosition === 'first' && changeOutput) psbt.addOutput(changeOutput)
  psbt.addOutput(recipientOutput)
  if (changeOutputPosition === 'last' && changeOutput) psbt.addOutput(changeOutput)
  if (
    psbt.txOutputs.some(output => output.script.equals(publicScript)) ||
    psbt.data.inputs.some(input => input.witnessUtxo?.script.equals(publicScript))
  ) {
    failInvalidBitcoinTransaction('Bitcoin private transfer cannot pay the public address')
  }

  const unsignedTransaction = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  const recipientOutputIndex = changeOutputPosition === 'first' ? 1 : 0
  const changeOutputIndex =
    changeOutputPosition === null ? null : changeOutputPosition === 'first' ? 0 : 1
  return Object.freeze({
    schemaVersion: 1,
    chainId: selection.chainId,
    accountIndex: selection.accountIndex,
    addressType: 'p2wpkh',
    psbtBase64: psbt.toBase64(),
    unsignedTransactionId: unsignedTransaction.getId(),
    transactionVersion: 2,
    lockTime: psbt.locktime,
    rbf: true,
    inputCount: selection.selectedUtxos.length,
    outputCount: changeOutput === null ? 1 : 2,
    recipient: selection.recipient,
    recipientOutputIndex,
    changeAddress: changeSats === 0n ? null : privateExecutionAddress,
    changeOutputIndex,
    selectedTotalSats: selection.selectedTotalSats,
    amountSats: selection.amountSats,
    feeSats: selection.feeSats,
    changeSats: selection.changeSats,
    estimatedVbytes: selection.estimatedVbytes,
    feeRateSatsPerVbyte: selection.feeRateSatsPerVbyte
  })
}
