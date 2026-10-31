import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSearchArguments, searchParameters } from '../src/search-cli.js'

const NOW = Date.UTC(2026, 9, 31, 15, 0, 0) / 1000

test('terms, operators and structural filters become bridge parameters', () => {
  const options = parseSearchArguments(['precio final', 'hotel', '--any', '--prefix', '--from', 'incoming', '--type', 'text,document', '--rank', '--limit', '200', '--json'], { nowSeconds: NOW })
  const parameters = searchParameters(options, { jid: 'tomi@lid' })
  assert.deepEqual(parameters.getAll('t'), ['precio final', 'hotel'])
  assert.equal(parameters.get('any'), '1')
  assert.equal(parameters.get('prefix'), '1')
  assert.equal(parameters.get('direction'), 'incoming')
  assert.equal(parameters.get('types'), 'conversation,extendedTextMessage,documentMessage')
  assert.equal(parameters.get('order'), 'relevance')
  assert.equal(parameters.get('limit'), '200')
  assert.equal(parameters.get('jid'), 'tomi@lid')
  assert.equal(options.json, true)
})

test('dates are local Montevideo days: --after is inclusive, --before exclusive, --date both', () => {
  const october1 = Date.UTC(2026, 9, 1, 3, 0, 0) / 1000
  const options = parseSearchArguments(['reserva', '--after', '2026-10-01', '--before', '2026-10-15'], { nowSeconds: NOW })
  assert.equal(options.after, october1)
  assert.equal(options.before, october1 + (14 * 86400))
  const single = parseSearchArguments(['reserva', '--date', '2026-10-01'], { nowSeconds: NOW })
  assert.deepEqual([single.after, single.before], [october1, october1 + 86400])
  assert.throws(() => parseSearchArguments(['x', '--after', '2026-10-15', '--before', '2026-10-01'], { nowSeconds: NOW }), /start before/)
})

test('a sender alias, a chat and a group list stay distinct from the terms', () => {
  const options = parseSearchArguments(['--groups', 'maspeak', 'presupuesto', '--since', '30d', '--from', 'ana', '--chat', 'tomi'], { nowSeconds: NOW })
  assert.deepEqual(options.terms, ['presupuesto'])
  assert.equal(options.groupList, 'maspeak')
  assert.equal(options.since, 30 * 86400)
  assert.equal(options.from, 'ana')
  assert.equal(options.chat, 'tomi')
  assert.throws(() => parseSearchArguments(['x', '--chat', 'tomi'], { allowChat: false }), /only for search-all/)
})

test('unknown options and empty searches are rejected instead of searched', () => {
  assert.throws(() => parseSearchArguments(['x', '--fuzzy']), /Unknown option: --fuzzy/)
  assert.throws(() => parseSearchArguments(['--ids']), /at least one term/)
  assert.throws(() => parseSearchArguments(['x', '--type', 'gif']), /Unknown --type gif/)
  assert.throws(() => parseSearchArguments(['x', '--from']), /--from needs a value/)
})
