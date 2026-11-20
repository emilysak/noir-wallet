import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  classifyListEntry,
  matchListedSite,
  originCacheKey,
  publishSiteList,
  readPublishedSiteList,
  splitListEntries
} from '../../../src/core/security/site-list.ts'

const PATH_ENTRY = 'https://evil.example/phish'
const PATH_PREFIX = 'https://evil.example/phish'

test('origin cache keys keep scheme and non-default port', () => {
  assert.equal(originCacheKey('http://evil.example/phish?q=1#fragment'), 'http://evil.example')
  assert.equal(originCacheKey('https://evil.example/phish'), 'https://evil.example')
  assert.equal(originCacheKey('https://evil.example:8443/phish'), 'https://evil.example:8443')
  assert.equal(originCacheKey('http://evil.example'), 'http://evil.example')
  assert.notEqual(originCacheKey('http://evil.example'), originCacheKey('https://evil.example'))
  assert.notEqual(
    originCacheKey('https://evil.example'),
    originCacheKey('https://evil.example:8443')
  )
  assert.equal(originCacheKey('http://evil.example:80/a'), 'http://evil.example')
  assert.equal(originCacheKey('https://evil.example:443/a'), 'https://evil.example')
  assert.equal(originCacheKey('http://localhost:3000/sign'), 'http://localhost:3000')
  assert.equal(originCacheKey('https://user:pass@evil.example/'), null)
  assert.equal(originCacheKey('not a url'), null)
})

test('keeps path entries out of the hostname and IP sets', () => {
  const split = splitListEntries([
    PATH_ENTRY,
    'https://evil.example/',
    'https://203.0.113.10/',
    'http://[0:0:0:0:0:0:0:1]/',
    'https://user:pass@evil.example/secret',
    'not a url'
  ])

  assert.deepEqual(split.paths, [PATH_PREFIX])
  assert.deepEqual(split.hostnames, ['evil.example'])
  assert.deepEqual(split.ips, ['203.0.113.10', '[::1]'])
  assert.equal(split.hostnames.includes('evil.example/phish'), false)

  const published = publishSiteList([PATH_ENTRY, 'https://evil.example/', 'https://203.0.113.10/'])
  assert.deepEqual(Object.keys(published).sort(), ['hostnames', 'ips', 'version'])
  const encoded = JSON.stringify(published)
  assert.equal(encoded.includes(PATH_PREFIX), false)
  assert.equal(encoded.includes('/phish'), false)
})

test('compares hostnames after UTS-46 punycode conversion', () => {
  assert.deepEqual(classifyListEntry('https://münchen.de'), {
    kind: 'hostname',
    value: 'xn--mnchen-3ya.de'
  })
  assert.deepEqual(classifyListEntry('https://xn--mnchen-3ya.de.'), {
    kind: 'hostname',
    value: 'xn--mnchen-3ya.de'
  })
  assert.deepEqual(classifyListEntry('https://ｅｘａｍｐｌｅ.com/a'), {
    kind: 'path',
    value: 'https://example.com/a'
  })

  const list = splitListEntries(['https://münchen.de/'])
  assert.equal(matchListedSite('https://xn--mnchen-3ya.de/login', list), true)
  assert.equal(matchListedSite('https://a.xn--mnchen-3ya.de/', list), false)
})

test('matches IP addresses exactly in canonical form', () => {
  const list = splitListEntries(['http://127.0.0.1/', 'http://[2001:db8::1]/'])
  assert.equal(matchListedSite('http://127.1/', list), true)
  assert.equal(matchListedSite('http://127.0.0.2/', list), false)
  assert.equal(matchListedSite('http://[2001:db8:0:0:0:0:0:1]/', list), true)
  assert.equal(matchListedSite('http://[2001:db8::2]/', list), false)
  assert.equal(matchListedSite('http://[::ffff:127.0.0.1]/', list), false)
  assert.equal(list.hostnames.includes('127.0.0.1'), false)
})

test('matches path prefixes on a URL segment boundary', () => {
  const list = splitListEntries([
    'https://evil.example/phish/',
    'http://127.0.0.1/admin',
    'https://evil.example:8443/phish?ignored=1#fragment'
  ])
  assert.deepEqual(list.paths, [
    'http://127.0.0.1/admin',
    'https://evil.example/phish',
    'https://evil.example:8443/phish'
  ])
  assert.equal(list.hostnames.includes('evil.example'), false)
  assert.equal(list.ips.includes('127.0.0.1'), false)

  assert.equal(matchListedSite('https://evil.example/phish', list), true)
  assert.equal(matchListedSite('https://evil.example/phish/login?x=1#y', list), true)
  assert.equal(matchListedSite('https://evil.example/phishing', list), false)
  assert.equal(matchListedSite('http://evil.example/phish', list), false)
  assert.equal(matchListedSite('https://evil.example:8443/phish/login', list), true)
  assert.equal(
    matchListedSite('https://evil.example/phish', {
      hostnames: [],
      ips: [],
      paths: list.paths
    }),
    true
  )
  assert.equal(matchListedSite('http://127.0.0.1/admin/panel', list), true)
  assert.equal(matchListedSite('http://127.0.0.1/', list), false)
})

test('drops path-shaped published entries and rejects a paths field', () => {
  const published = readPublishedSiteList({
    version: 1,
    hostnames: ['https://evil.example/phish', 'münchen.de', 'evil.example'],
    ips: ['127.0.0.1', '127.0.0.1/admin', '[::1]']
  })
  assert.deepEqual(published, {
    version: 1,
    hostnames: ['evil.example', 'xn--mnchen-3ya.de'],
    ips: ['127.0.0.1', '[::1]']
  })
  assert.equal(
    readPublishedSiteList({
      version: 1,
      hostnames: [],
      ips: [],
      paths: [PATH_PREFIX]
    }),
    null
  )
})

test('published registry source does not contain path prefixes', async () => {
  const registry = await readFile(
    new URL('../../../../rpc-registry/src/site-list.ts', import.meta.url),
    'utf8'
  )
  const extensionPaths = await readFile(
    new URL('../../../src/core/security/site-list-paths.ts', import.meta.url),
    'utf8'
  )
  assert.equal(registry.includes('documents'), true)
  assert.equal(registry.includes('paths'), false)
  assert.equal(registry.includes('://'), false)
  assert.equal(extensionPaths.includes(PATH_PREFIX), false)
  const source = JSON.parse(
    await readFile(
      new URL('../../../src/core/security/site-list-entries.json', import.meta.url),
      'utf8'
    )
  ) as unknown
  assert.deepEqual(source, [])
  assert.deepEqual(splitListEntries([]), { version: 1, hostnames: [], ips: [], paths: [] })
})
