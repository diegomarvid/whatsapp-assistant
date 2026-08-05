import assert from 'node:assert/strict'
import test from 'node:test'
import { AutomationCapabilities } from '../src/automation-capabilities.js'

test('an automation capability is scoped by action, chat, expiry, and revocation', () => {
  let now = 1000
  const capabilities = new AutomationCapabilities({ now: () => now })
  const token = capabilities.issue({ readJids: ['ines@lid', '59894070759@s.whatsapp.net'], sendJids: ['ines@lid', '59894070759@s.whatsapp.net'], ttlMs: 5000 })
  const authorization = capabilities.authorization(token, 'master-token')
  assert.equal(authorization.kind, 'automation')
  assert.equal(capabilities.canRead(authorization, 'ines@lid'), true)
  assert.equal(capabilities.canSend(authorization, 'ines@lid'), true)
  assert.equal(capabilities.canRead(authorization, 'other@lid'), false)
  assert.equal(capabilities.canResolve(authorization, '59894070759@s.whatsapp.net'), true)
  assert.equal(capabilities.authorization('wrong-token', 'master-token'), null)
  now += 5001
  assert.equal(capabilities.authorization(token, 'master-token'), null)

  const revocable = capabilities.issue({ readJids: ['a@lid'], sendJids: ['b@lid'], ttlMs: 5000 })
  capabilities.revoke(revocable)
  assert.equal(capabilities.authorization(revocable, 'master-token'), null)
})

test('the master bridge credential retains full access', () => {
  const capabilities = new AutomationCapabilities()
  const authorization = capabilities.authorization('master-token', 'master-token')
  assert.equal(authorization.kind, 'full')
  assert.equal(capabilities.canRead(authorization, 'any@lid'), true)
  assert.equal(capabilities.canSend(authorization, 'any@lid'), true)
})
