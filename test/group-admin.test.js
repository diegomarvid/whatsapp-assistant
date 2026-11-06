import assert from 'node:assert/strict'
import test from 'node:test'
import { jidNormalizedUser } from 'baileys'
import { GROUP_SUBJECT_MAX_LENGTH, createdGroupSummary, creationParticipants, isGroupParticipantJid, validateGroupPhoto, markAmbiguousCreateFailure, validateGroupCreate } from '../src/group-admin.js'

test('accepts a named group of direct contacts and drops repeated people', () => {
  assert.deepEqual(
    validateGroupCreate({ subject: '  Maspeak <> Hotel  ', participants: ['111@lid', '598000@s.whatsapp.net', '111@lid'] }),
    { subject: 'Maspeak <> Hotel', participants: ['111@lid', '598000@s.whatsapp.net'] },
  )
})

test('rejects a missing or oversized name and anything that is not a person', () => {
  assert.equal(validateGroupCreate({ subject: '   ', participants: ['111@lid'] }).error, 'invalid_group_subject')
  assert.equal(validateGroupCreate({ subject: 'x'.repeat(GROUP_SUBJECT_MAX_LENGTH + 1), participants: ['111@lid'] }).error, 'invalid_group_subject')
  assert.equal(validateGroupCreate({ subject: 'Prueba', participants: [] }).error, 'invalid_group_participants')
  assert.equal(validateGroupCreate({ subject: 'Prueba', participants: ['work@g.us'] }).error, 'invalid_group_participants')
  assert.equal(validateGroupCreate({ subject: 'Prueba', participants: ['status@broadcast'] }).error, 'invalid_group_participants')
  assert.equal(validateGroupCreate({ subject: 'Prueba' }).error, 'invalid_group_participants')
  assert.equal(isGroupParticipantJid('111@lid'), true)
  assert.equal(isGroupParticipantJid('work@g.us'), false)
})

test('a timeout or closed connection is ambiguous; a WhatsApp error answer is not', () => {
  const timeout = markAmbiguousCreateFailure(Object.assign(new Error('Timed Out'), { output: { statusCode: 408 } }))
  const closed = markAmbiguousCreateFailure(Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } }))
  const unknown = markAmbiguousCreateFailure(new Error('socket hang up'))
  const rejected = markAmbiguousCreateFailure(Object.assign(new Error('bad-request'), { output: { statusCode: 400 } }))
  assert.equal(timeout.ambiguous, true)
  assert.equal(closed.ambiguous, true)
  assert.equal(unknown.ambiguous, true)
  assert.equal(rejected.ambiguous, undefined)
})

test('reports who WhatsApp actually added, matching phone and LID equivalents', () => {
  const metadata = {
    id: '120363000000000001@g.us',
    subject: 'Prueba',
    participants: [
      { id: '999@lid', phoneNumber: '598999@s.whatsapp.net', admin: 'superadmin' },
      { id: '111@lid', admin: null },
      { id: '598222:3@s.whatsapp.net', admin: null },
    ],
  }
  const summary = createdGroupSummary(metadata, [
    { jid: '111@lid', aliases: ['111@lid', '598111@s.whatsapp.net'] },
    { jid: '222@lid', aliases: ['222@lid', '598222@s.whatsapp.net'] },
    { jid: '333@lid', aliases: ['333@lid'] },
  ], jidNormalizedUser)
  assert.equal(summary.jid, '120363000000000001@g.us')
  assert.equal(summary.subject, 'Prueba')
  assert.deepEqual(summary.participants[0], { jid: '999@lid', phoneNumber: '598999@s.whatsapp.net', lid: null, admin: 'superadmin' })
  assert.deepEqual(summary.notAdded, ['333@lid'])
})

test('creation addresses people by their known phone JID, never derived from LID digits', () => {
  assert.deepEqual(creationParticipants([
    { jid: '111@lid', aliases: ['111@lid', '598111@s.whatsapp.net'] },
    { jid: '598222@s.whatsapp.net', aliases: ['598222@s.whatsapp.net', '222@lid'] },
    { jid: '333@lid', aliases: ['333@lid'] },
    { jid: '444@lid', aliases: ['444@lid', '598111@s.whatsapp.net'] },
  ]), ['598111@s.whatsapp.net', '598222@s.whatsapp.net', '333@lid'])
})

test('a group photo needs a group JID and an absolute JPG, PNG or WebP path', () => {
  assert.deepEqual(validateGroupPhoto({ jid: '120363000000000001@g.us', filePath: '/tmp/logo.PNG' }), { jid: '120363000000000001@g.us', filePath: '/tmp/logo.PNG' })
  assert.equal(validateGroupPhoto({ jid: '111@lid', filePath: '/tmp/logo.png' }).error, 'invalid_group_jid')
  assert.equal(validateGroupPhoto({ jid: '120363000000000001@g.us', filePath: 'logo.png' }).error, 'invalid_group_photo')
  assert.equal(validateGroupPhoto({ jid: '120363000000000001@g.us', filePath: '/tmp/logo.gif' }).error, 'invalid_group_photo')
  assert.equal(validateGroupPhoto({}).error, 'invalid_group_jid')
})
