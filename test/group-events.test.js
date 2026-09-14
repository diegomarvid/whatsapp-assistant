import assert from 'node:assert/strict'
import test from 'node:test'
import { applyGroupParticipantUpdates } from '../src/group-events.js'

test('ingests the single-object Baileys participant event without aborting the batch', () => {
  const recorded = []
  const events = {
    'group-participants.update': {
      id: 'example@g.us', author: 'operator@lid', action: 'add',
      participants: [{ id: 'member@lid', phoneNumber: '123@s.whatsapp.net' }],
    },
  }
  const changed = applyGroupParticipantUpdates(events['group-participants.update'], event => {
    recorded.push(event)
    return true
  })
  assert.equal(changed, true)
  assert.deepEqual(recorded, [{
    groupJid: 'example@g.us', kind: 'participant', action: 'add',
    participant: 'member@lid', author: 'operator@lid',
  }])
})

test('preserves array and string participant compatibility and visits every participant', () => {
  const recorded = []
  assert.equal(applyGroupParticipantUpdates([
    { id: 'example@g.us', action: 'remove', participants: ['first@lid', 'second@lid'] },
    { id: 'other@g.us', action: 'promote', participants: [{ id: 'third@lid' }] },
  ], event => { recorded.push(event); return true }), true)
  assert.deepEqual(recorded.map(event => event.participant), ['first@lid', 'second@lid', 'third@lid'])
  assert.equal(recorded[2].groupJid, 'other@g.us')
})

test('empty or malformed group updates do not break ingestion of later valid entries', () => {
  const recorded = []
  const append = event => { recorded.push(event); return true }
  for (const input of [null, undefined, {}, { id: 'example@g.us', participants: {} }]) {
    assert.equal(applyGroupParticipantUpdates(input, append), false)
  }
  assert.equal(applyGroupParticipantUpdates([
    null, { id: 'example@g.us', participants: [null, {}, 123, '', { id: 'valid@lid' }] },
  ], append), true)
  assert.deepEqual(recorded.map(event => event.participant), ['valid@lid'])
})
