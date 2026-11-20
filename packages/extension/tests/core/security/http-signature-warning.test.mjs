import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HTTP_SIGNATURE_WARNING,
  httpSignatureWarning
} from '../../../src/core/dapp/http-signature-warning.ts'

test('warns for message signatures from canonical http origins', () => {
  assert.equal(
    httpSignatureWarning('http://evil.example', 'message'),
    HTTP_SIGNATURE_WARNING
  )
  assert.equal(
    httpSignatureWarning('http://localhost:3000', 'message'),
    HTTP_SIGNATURE_WARNING
  )
  assert.equal(httpSignatureWarning('http://127.0.0.1:8080', 'message'), HTTP_SIGNATURE_WARNING)
  assert.equal(httpSignatureWarning('https://evil.example', 'message'), null)
  assert.equal(httpSignatureWarning('http://evil.example', 'transaction'), null)
  assert.equal(httpSignatureWarning('https://evil.example', 'transaction'), null)
  assert.equal(httpSignatureWarning('http://evil.example/sign', 'message'), null)
  assert.equal(httpSignatureWarning('http://evil.example:80', 'message'), null)
})
