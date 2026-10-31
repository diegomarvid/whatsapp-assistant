import { REVIEW_TIME_ZONE, reviewDateRange } from './conversation-review.js'
import { parseSince } from './search-scope.js'

// Friendly media names for --type; exact WhatsApp type names (…Message) are
// also accepted. Purely structural filters.
const TYPE_ALIASES = {
  text: ['conversation', 'extendedTextMessage'],
  image: ['imageMessage'],
  audio: ['audioMessage'],
  video: ['videoMessage', 'ptvMessage'],
  document: ['documentMessage'],
  sticker: ['stickerMessage'],
  location: ['locationMessage', 'liveLocationMessage'],
  contact: ['contactMessage', 'contactsArrayMessage'],
}

// Arguments of `wa search <contact> …` and `wa search-all …`. Every argument
// that is not an option is a search term; quote several words to search them
// as a phrase.
export function parseSearchArguments(args, { nowSeconds = Math.floor(Date.now() / 1000), timeZone = REVIEW_TIME_ZONE, allowChat = true } = {}) {
  const options = { terms: [], any: false, prefix: false, raw: false, scope: 'all', groupList: null, chat: null, from: null, since: null, after: null, before: null, types: [], order: 'recent', limit: 50, ids: false, json: false }
  const rest = [...args]
  const valueFor = (option) => {
    const value = rest.shift()
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value.`)
    return value
  }
  const day = (option) => reviewDateRange(valueFor(option), { nowSeconds, timeZone })
  while (rest.length) {
    const argument = rest.shift()
    if (argument === '--any') options.any = true
    else if (argument === '--prefix') options.prefix = true
    else if (argument === '--raw') options.raw = true
    else if (argument === '--direct') options.scope = 'direct'
    else if (argument === '--groups') {
      options.scope = 'groups'
      if (rest[0] && !rest[0].startsWith('--')) options.groupList = rest.shift()
    } else if (argument === '--since') options.since = parseSince(valueFor(argument))
    else if (argument === '--after') options.after = day(argument).since
    else if (argument === '--before') options.before = day(argument).since
    else if (argument === '--date') {
      const range = day(argument)
      options.after = range.since
      options.before = range.until
    } else if (argument === '--chat') {
      if (!allowChat) throw new Error('--chat is only for search-all; wa search already names the chat.')
      options.chat = valueFor(argument)
    } else if (argument === '--from') options.from = valueFor(argument)
    else if (argument === '--type') {
      for (const name of valueFor(argument).split(',').map((value) => value.trim()).filter(Boolean)) {
        if (TYPE_ALIASES[name]) options.types.push(...TYPE_ALIASES[name])
        else if (/^[a-z]+Message$/i.test(name)) options.types.push(name)
        else throw new Error(`Unknown --type ${name}. Use ${Object.keys(TYPE_ALIASES).join('|')} or a WhatsApp type name.`)
      }
    } else if (argument === '--rank') options.order = 'relevance'
    else if (argument === '--limit') {
      const limit = Number.parseInt(valueFor(argument), 10)
      if (!Number.isFinite(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be between 1 and 1000.')
      options.limit = limit
    } else if (argument === '--ids') options.ids = true
    else if (argument === '--json') options.json = true
    else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`)
    else options.terms.push(argument)
  }
  if (!options.terms.length) throw new Error('Search needs at least one term.')
  if (options.after != null && options.before != null && options.after >= options.before) throw new Error('The search window must start before it ends.')
  return options
}

export function searchParameters(options, { jid = null, sender = null, groupJids = null } = {}) {
  const parameters = new URLSearchParams()
  for (const term of options.terms) parameters.append('t', term)
  if (options.any) parameters.set('any', '1')
  if (options.prefix) parameters.set('prefix', '1')
  if (options.raw) parameters.set('raw', '1')
  if (options.scope !== 'all') parameters.set('scope', options.scope)
  if (jid) parameters.set('jid', jid)
  if (groupJids?.length) parameters.set('jids', groupJids.join(','))
  if (sender) parameters.set('sender', sender)
  if (['me', 'incoming'].includes(options.from)) parameters.set('direction', options.from)
  if (options.since) parameters.set('since', String(options.since))
  if (options.after != null) parameters.set('after', String(options.after))
  if (options.before != null) parameters.set('before', String(options.before))
  if (options.types.length) parameters.set('types', [...new Set(options.types)].join(','))
  if (options.order === 'relevance') parameters.set('order', 'relevance')
  parameters.set('limit', String(options.limit))
  return parameters
}
