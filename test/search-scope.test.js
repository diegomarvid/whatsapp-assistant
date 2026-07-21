import assert from 'node:assert/strict'
import test from 'node:test'
import { isDirectChat, parseSince, searchAllMatches } from '../src/search-scope.js'

const now = 1_784_000_000
const messages = [
  { jid: '1@lid', id: 'a', timestamp: now - (6 * 86400), text: 'presupuesto viejo' },
  { jid: '1@lid', id: 'b', timestamp: now - 3600, text: 'presupuesto nuevo' },
  { jid: 'work@g.us', id: 'c', timestamp: now - 7200, text: 'presupuesto del grupo' },
  { jid: 'otro@g.us', id: 'd', timestamp: now - 7200, text: 'presupuesto ajeno' },
  { jid: '1@lid', id: 'e', timestamp: now - 60, text: 'otra cosa' },
]

test('search-all without --since searches the whole retained window', () => {
  const matches = searchAllMatches({ messages, query: 'presupuesto', nowSeconds: now })
  assert.deepEqual(matches.map((message) => message.id), ['b', 'c', 'd', 'a'])
})

test('search-all with --since bounds the window', () => {
  const matches = searchAllMatches({ messages, query: 'presupuesto', nowSeconds: now, sinceSeconds: 2 * 3600 })
  assert.deepEqual(matches.map((message) => message.id), ['b', 'c', 'd'])
})

test('search-all scopes to direct chats or an allowed group list', () => {
  assert.deepEqual(searchAllMatches({ messages, query: 'presupuesto', nowSeconds: now, scope: 'direct' }).map((message) => message.id), ['b', 'a'])
  assert.deepEqual(searchAllMatches({ messages, query: 'presupuesto', nowSeconds: now, scope: 'groups', allowedGroups: new Set(['work@g.us']) }).map((message) => message.id), ['c'])
})

test('parseSince accepts hours and days only', () => {
  assert.equal(parseSince('12h'), 12 * 3600)
  assert.equal(parseSince('7d'), 7 * 86400)
  assert.throws(() => parseSince('7w'), /--since/)
})

test('isDirectChat excludes groups and broadcast', () => {
  assert.equal(isDirectChat('1@lid'), true)
  assert.equal(isDirectChat('1@s.whatsapp.net'), true)
  assert.equal(isDirectChat('work@g.us'), false)
  assert.equal(isDirectChat('status@broadcast'), false)
  assert.equal(isDirectChat(null), false)
})
