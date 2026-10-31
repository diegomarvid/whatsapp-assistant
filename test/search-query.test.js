import test from 'node:test'
import assert from 'node:assert/strict'
import { ftsQuery } from '../src/search-query.js'

test('each argument is a whole-word term joined with AND; a multi-word argument is a phrase', () => {
  assert.equal(ftsQuery(['presupuesto']), '"presupuesto"')
  assert.equal(ftsQuery(['precio final', 'hotel']), '"precio final" AND "hotel"')
})

test('punctuation never reaches the FTS5 parser', () => {
  assert.equal(ftsQuery(['"OR" NOT(*)', 'e-mail:']), '"OR NOT" AND "e mail"')
  assert.throws(() => ftsQuery(['¿?', '--']), /letters or digits/)
  assert.throws(() => ftsQuery([]), /at least one term/)
})

test('any, prefix and raw change only the operator, the suffix or the parsing', () => {
  assert.equal(ftsQuery(['reserva', 'booking'], { any: true }), '"reserva" OR "booking"')
  assert.equal(ftsQuery(['reserv'], { prefix: true }), '"reserv"*')
  assert.equal(ftsQuery(['reserva NOT cancelada'], { raw: true }), 'reserva NOT cancelada')
})
