import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  shouldAutoConnectDApp,
  shouldAutoConnectDAppForBuild
} from '../../../src/core/dapp/first-party-policy.ts'

const describe = it.describe

const handlerSource = readFileSync(
  new URL('../../../src/background/dapp-handler.ts', import.meta.url),
  'utf-8'
)

describe('zkNoir application integration', () => {
  it('auto-connects only the exact first-party application origins for the build', () => {
    const official = 'https://app.zknoir.com'
    const staging = 'https://noirdevelop.refburrow.top'
    assert.equal(shouldAutoConnectDApp(official), true)
    assert.equal(shouldAutoConnectDApp(staging), true)
    for (const buildChannel of ['development', 'beta']) {
      assert.equal(shouldAutoConnectDAppForBuild(official, buildChannel), true)
      assert.equal(shouldAutoConnectDAppForBuild(staging, buildChannel), true)
    }
    assert.equal(shouldAutoConnectDAppForBuild(official, 'production'), true)
    assert.equal(shouldAutoConnectDAppForBuild(staging, 'production'), false)
    assert.equal(shouldAutoConnectDAppForBuild(official, 'candidate'), true)
    assert.equal(shouldAutoConnectDAppForBuild(staging, 'candidate'), false)

    for (const host of ['app.zknoir.com', 'noirdevelop.refburrow.top']) {
      for (const origin of [
        `http://${host}`,
        `https://evil.${host}`,
        `https://${host}.evil.example`,
        `https://${host}:8443`,
        `https://${host}/lending`
      ]) {
        assert.equal(shouldAutoConnectDApp(origin), false)
        for (const buildChannel of ['development', 'beta', 'production']) {
          assert.equal(shouldAutoConnectDAppForBuild(origin, buildChannel), false)
        }
      }
    }
  })

  it('synchronizes every wallet account without bypassing action approvals', () => {
    assert.match(
      handlerSource,
      /private async authorizeAllWalletAccounts[\s\S]*?this\.buildAllWalletAccounts\(\)/
    )
    assert.match(
      handlerSource,
      /private async getAccounts[\s\S]*?shouldAutoConnectDApp\(origin\)[\s\S]*?authorizeAllWalletAccounts\(origin\)/
    )
    assert.match(
      handlerSource,
      /private async requestAccounts[\s\S]*?shouldAutoConnectDApp\(origin\)[\s\S]*?authorizeAllWalletAccounts\(origin\)/
    )
    assert.match(
      handlerSource,
      /private async ensurePermission[\s\S]*?shouldAutoConnectDApp\(origin\)[\s\S]*?authorizeAllWalletAccounts\(origin\)/
    )
    assert.match(handlerSource, /private async sendTransaction[\s\S]*?requestUserApprovalWithId/)
    assert.match(
      handlerSource,
      /private async signMessage[\s\S]*?requestUserApproval\([\s\S]*?origin,[\s\S]*?'signMessage'/
    )
    assert.match(
      handlerSource,
      /private async shieldFunds[\s\S]*?requestUserApprovalWithId\([\s\S]*?origin,[\s\S]*?'shieldFunds'/
    )
  })
})
