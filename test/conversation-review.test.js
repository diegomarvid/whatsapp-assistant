import assert from 'node:assert/strict'
import test from 'node:test'
import { formatReviewLocalTimestamp, reviewDateRange, reviewWindow, selectConversationReview } from '../src/conversation-review.js'

const nowSeconds = Math.floor(Date.parse('2026-09-02T17:45:00Z') / 1000)

test('review date ranges follow the Montevideo calendar and stop at now for today', () => {
  const today = reviewDateRange('today', { nowSeconds })
  assert.equal(today.localDate, '2026-09-02')
  assert.equal(new Date(today.since * 1000).toISOString(), '2026-09-02T03:00:00.000Z')
  assert.equal(today.until, nowSeconds)

  const yesterday = reviewDateRange('yesterday', { nowSeconds })
  assert.equal(yesterday.localDate, '2026-09-01')
  assert.equal(new Date(yesterday.since * 1000).toISOString(), '2026-09-01T03:00:00.000Z')
  assert.equal(new Date(yesterday.until * 1000).toISOString(), '2026-09-02T03:00:00.000Z')
})

test('review windows accept relative bounds and reject contradictory options', () => {
  const relative = reviewWindow({ since: '12h', nowSeconds })
  assert.equal(relative.since, nowSeconds - (12 * 3600))
  assert.equal(relative.until, nowSeconds)
  assert.throws(() => reviewWindow({ date: 'today', since: '12h', nowSeconds }), /do not combine/)
  assert.throws(() => reviewDateRange('02-09-2026', { nowSeconds }), /--date/)
})

test('review windows accept local clock bounds on a chosen Montevideo date', () => {
  const window = reviewWindow({ date: '2026-09-02', start: '09:00', end: '11:00', nowSeconds })
  assert.equal(new Date(window.since * 1000).toISOString(), '2026-09-02T12:00:00.000Z')
  assert.equal(new Date(window.until * 1000).toISOString(), '2026-09-02T14:00:00.000Z')
  assert.equal(formatReviewLocalTimestamp(window.since), '2026-09-02 09:00:00')
  assert.equal(formatReviewLocalTimestamp(window.until), '2026-09-02 11:00:00')
  assert.throws(() => reviewWindow({ start: '09:00', end: '11:00', nowSeconds }), /together with --date/)
  assert.throws(() => reviewWindow({ date: 'today', start: '25:00', nowSeconds }), /HH:MM/)
})

test('review selection matches normalized terms and collapses overlapping context', () => {
  const start = reviewDateRange('today', { nowSeconds }).since
  const messages = [
    { id: 'before', timestamp: start + 10, text: 'che escucha', type: 'conversation' },
    { id: 'static', timestamp: start + 20, text: 'La IP del grant es estática', type: 'conversation' },
    { id: 'dynamic', timestamp: start + 30, text: 'sin enterprise la IP es dinamica', type: 'conversation' },
    { id: 'audio', timestamp: start + 40, text: '', type: 'audioMessage', audioRef: 'audio.bin' },
    { id: 'after', timestamp: start + 50, text: 'lo revisamos', type: 'conversation' },
    { id: 'substring-one', timestamp: start + 60, text: 'Tipo pila de problemas', type: 'conversation' },
    { id: 'substring-two', timestamp: start + 70, text: 'disminuir el horario de atencipn?', type: 'conversation' },
    { id: 'far', timestamp: start + 600, text: 'tema distinto', type: 'conversation' },
  ]
  const selected = selectConversationReview(messages, {
    since: start,
    until: nowSeconds,
    terms: ['IP', 'dinámica', 'estatica'],
    mode: 'any',
    context: 1,
  })
  assert.deepEqual(selected.matching.map((entry) => entry.message.id), ['static', 'dynamic'])
  assert.deepEqual(selected.timeline.map((message) => message.id), ['before', 'static', 'dynamic', 'audio'])
  assert.equal(selected.timeline.find((message) => message.id === 'dynamic').review.isMatch, true)
  assert.deepEqual(selected.timeline.find((message) => message.id === 'dynamic').review.matchedTerms, ['IP', 'dinámica'])
  assert.deepEqual(selected.media, [{ id: 'audio', timestamp: start + 40, fromMe: false, type: 'audioMessage', available: true }])
})

test('short review terms match whole words or phrases, not accidental substrings', () => {
  const messages = [
    { id: 'ip', timestamp: 100, text: 'La IP puede cambiar', type: 'conversation' },
    { id: 'phrase', timestamp: 110, text: 'Necesitamos IP ESTÁTICA.', type: 'conversation' },
    { id: 'tipo', timestamp: 120, text: 'Tipo pila de problemas', type: 'conversation' },
    { id: 'typo', timestamp: 130, text: 'horario de atencipn', type: 'conversation' },
  ]
  const selected = selectConversationReview(messages, { since: 90, until: 140, terms: ['IP', 'ip estatica'], context: 0 })
  assert.deepEqual(selected.matching.map((entry) => entry.message.id), ['ip', 'phrase'])
})

test('all mode requires every term in the same message and no terms returns the whole window', () => {
  const messages = [
    { id: 'one', timestamp: 100, text: 'IP dinámica', type: 'conversation' },
    { id: 'two', timestamp: 110, text: 'IP estática', type: 'conversation' },
  ]
  const all = selectConversationReview(messages, { since: 90, until: 120, terms: ['IP', 'dinámica'], mode: 'all', context: 0 })
  assert.deepEqual(all.matching.map((entry) => entry.message.id), ['one'])
  const complete = selectConversationReview(messages, { since: 90, until: 120, context: 4 })
  assert.deepEqual(complete.timeline.map((message) => message.id), ['one', 'two'])
})

test('sender filtering limits matches while preserving both sides as context', () => {
  const messages = [
    { id: 'incoming', timestamp: 100, fromMe: false, text: 'IP dinámica', type: 'conversation' },
    { id: 'own', timestamp: 110, fromMe: true, text: 'Mi resumen de IP dinámica', type: 'conversation' },
    { id: 'after', timestamp: 120, fromMe: false, text: 'dale', type: 'conversation' },
  ]
  const selected = selectConversationReview(messages, { since: 90, until: 130, terms: ['IP'], from: 'incoming', context: 1 })
  assert.deepEqual(selected.matching.map((entry) => entry.message.id), ['incoming'])
  assert.deepEqual(selected.timeline.map((message) => message.id), ['incoming', 'own'])
})
