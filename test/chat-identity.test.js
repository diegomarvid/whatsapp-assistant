import assert from 'node:assert/strict'
import test from 'node:test'
import { chatNameFromMessage, repairedChatNames } from '../src/chat-identity.js'

test('an incoming direct message names its chat with the sender pushName', () => {
  assert.equal(chatNameFromMessage({ jid: '123@s.whatsapp.net', fromMe: false, participant: null, pushName: 'Gisell' }), 'Gisell')
  assert.equal(chatNameFromMessage({ jid: '456@lid', fromMe: false, participant: null, pushName: 'Flor' }), 'Flor')
})

test('a fromMe pushName never names the chat: it is the account owner, not the contact', () => {
  assert.equal(chatNameFromMessage({ jid: '123@s.whatsapp.net', fromMe: true, participant: null, pushName: 'Diego' }), null)
})

test('a group participant pushName never names the group chat', () => {
  assert.equal(chatNameFromMessage({ jid: 'work@g.us', fromMe: false, participant: '123@lid', pushName: 'Tomi' }), null)
  assert.equal(chatNameFromMessage({ jid: 'work@g.us', fromMe: false, participant: null, pushName: 'Tomi' }), null)
})

test('repairs direct chats contaminated with the owner name using chat evidence', () => {
  const repairs = repairedChatNames({
    ownName: 'Diego',
    chats: {
      'a@lid': { jid: 'a@lid', name: 'Diego' },
      'b@lid': { jid: 'b@lid', name: 'Diego' },
      'c@lid': { jid: 'c@lid', name: 'Gisell' },
      'd@lid': { jid: 'd@lid', name: 'Diego' },
      'work@g.us': { jid: 'work@g.us', name: 'Diego' },
    },
    messages: [
      { jid: 'a@lid', fromMe: false, participant: null, pushName: 'Gisell Vieja', timestamp: 10 },
      { jid: 'a@lid', fromMe: false, participant: null, pushName: 'Gisell', timestamp: 20 },
      { jid: 'a@lid', fromMe: true, participant: null, pushName: 'Diego', timestamp: 30 },
      { jid: 'd@lid', fromMe: false, participant: null, pushName: 'Diego', timestamp: 20 },
    ],
    contacts: { 'b@lid': { id: 'b@lid', name: 'Flor' } },
  })
  assert.deepEqual(repairs, [
    { jid: 'a@lid', name: 'Gisell' },
    { jid: 'b@lid', name: 'Flor' },
  ])
})

test('repairs nothing without an own name to compare against', () => {
  assert.deepEqual(repairedChatNames({ chats: { 'a@lid': { jid: 'a@lid', name: 'Diego' } } }), [])
})

test('broadcast and empty identities never name a chat', () => {
  assert.equal(chatNameFromMessage({ jid: 'status@broadcast', fromMe: false, participant: null, pushName: 'Alguien' }), null)
  assert.equal(chatNameFromMessage({ jid: '123@s.whatsapp.net', fromMe: false, participant: null, pushName: null }), null)
  assert.equal(chatNameFromMessage(), null)
})
