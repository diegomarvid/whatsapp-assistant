import test from 'node:test'
import assert from 'node:assert/strict'
import { LinkState, linkOptions, shouldReconnect } from '../src/link-state.js'
import { DisconnectReason } from 'baileys'

test('full history remains enabled with a web browser descriptor', () => {
  const options = linkOptions({ syncFullHistory: true })
  assert.equal(options.browser[1], 'Chrome')
  assert.equal(options.syncFullHistory, true)
  assert.equal(linkOptions({ syncFullHistory: false }).syncFullHistory, false)
})
test('QR expires and is rejected outside the connecting socket', () => {
  let now = 1000
  const state = new LinkState(() => now)
  state.publish(state.generation, 'private-code')
  assert.equal(state.pending('connecting').code, 'private-code')
  for (const connection of ['open', 'disconnected', 'logged_out', 'stopping']) assert.equal(state.pending(connection), null)
  now += 60000
  assert.equal(state.pending('connecting'), null)
})
test('disconnect, socket replacement and delayed old QR cannot resurrect a lease', () => {
  const state = new LinkState()
  const old = state.generation
  state.publish(old, 'old')
  state.clear()
  assert.equal(state.pending('connecting'), null)
  state.begin()
  state.publish(old, 'late')
  assert.equal(state.pending('connecting'), null)
  state.publish(state.generation, 'new')
  const id = state.pending('connecting').id
  state.publish(state.generation, 'rotated')
  assert.notEqual(state.pending('connecting').id, id)
})
test('registration failures stop; pair success gets one restart; established auth reconnects', () => {
  for (const statusCode of [428, 408, 500, undefined]) assert.equal(shouldReconnect({ registered: false, statusCode, pairingRestarts: 0 }), false)
  assert.equal(shouldReconnect({ registered: false, statusCode: DisconnectReason.restartRequired, pairingRestarts: 0 }), true)
  assert.equal(shouldReconnect({ registered: false, statusCode: DisconnectReason.restartRequired, pairingRestarts: 1 }), false)
  assert.equal(shouldReconnect({ registered: true, statusCode: 428 }), true)
  assert.equal(shouldReconnect({ registered: true, statusCode: DisconnectReason.loggedOut }), false)
})
