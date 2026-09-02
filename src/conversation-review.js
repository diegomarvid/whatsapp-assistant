import { parseSince } from './search-scope.js'

export const REVIEW_TIME_ZONE = 'America/Montevideo'

function formatterFor(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

function zonedParts(epochMilliseconds, timeZone) {
  return Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(epochMilliseconds))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number.parseInt(part.value, 10)]),
  )
}

function offsetAt(epochMilliseconds, timeZone) {
  const parts = zonedParts(epochMilliseconds, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - epochMilliseconds
}

function epochForLocalMidnight(date, timeZone) {
  const [year, month, day] = date.split('-').map((value) => Number.parseInt(value, 10))
  const utcGuess = Date.UTC(year, month - 1, day)
  let epoch = utcGuess - offsetAt(utcGuess, timeZone)
  epoch = utcGuess - offsetAt(epoch, timeZone)
  return Math.floor(epoch / 1000)
}

function parseLocalTime(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/)
  if (!match) throw new Error('Use local time as HH:MM or HH:MM:SS')
  return {
    hour: Number.parseInt(match[1], 10),
    minute: Number.parseInt(match[2], 10),
    second: Number.parseInt(match[3] || '0', 10),
  }
}

function epochForLocalTime(date, time, timeZone) {
  const [year, month, day] = date.split('-').map((value) => Number.parseInt(value, 10))
  const parsedTime = parseLocalTime(time)
  const utcGuess = Date.UTC(year, month - 1, day, parsedTime.hour, parsedTime.minute, parsedTime.second)
  let epoch = utcGuess - offsetAt(utcGuess, timeZone)
  epoch = utcGuess - offsetAt(epoch, timeZone)
  const resolved = zonedParts(epoch, timeZone)
  if (resolved.year !== year || resolved.month !== month || resolved.day !== day
    || resolved.hour !== parsedTime.hour || resolved.minute !== parsedTime.minute || resolved.second !== parsedTime.second) {
    throw new Error(`Local time does not exist in ${timeZone}: ${date} ${time}`)
  }
  return Math.floor(epoch / 1000)
}

function localDateAt(epochSeconds, timeZone) {
  const parts = zonedParts(epochSeconds * 1000, timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function formatReviewLocalTimestamp(epochSeconds, timeZone = REVIEW_TIME_ZONE) {
  const parts = zonedParts(epochSeconds * 1000, timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`
}

function shiftDate(date, days) {
  const [year, month, day] = date.split('-').map((value) => Number.parseInt(value, 10))
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

function resolveDate(value, nowSeconds, timeZone) {
  const today = localDateAt(nowSeconds, timeZone)
  if (value === 'today') return today
  if (value === 'yesterday') return shiftDate(today, -1)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`)
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return value
  }
  throw new Error('Use --date <today|yesterday|YYYY-MM-DD>')
}

export function reviewDateRange(value, { nowSeconds = Math.floor(Date.now() / 1000), timeZone = REVIEW_TIME_ZONE } = {}) {
  const date = resolveDate(value, nowSeconds, timeZone)
  const since = epochForLocalMidnight(date, timeZone)
  const nextMidnight = epochForLocalMidnight(shiftDate(date, 1), timeZone)
  return {
    label: value,
    localDate: date,
    since,
    until: Math.min(nextMidnight, nowSeconds),
    timeZone,
  }
}

function explicitBoundary(value, { nowSeconds, timeZone, endOfDay = false }) {
  if (value === 'now') return nowSeconds
  if (/^\d+(h|d)$/.test(value)) return nowSeconds - parseSince(value)
  const range = reviewDateRange(value, { nowSeconds, timeZone })
  return endOfDay ? range.until : range.since
}

export function reviewWindow({ date = null, start = null, end = null, since = null, until = null, nowSeconds = Math.floor(Date.now() / 1000), timeZone = REVIEW_TIME_ZONE } = {}) {
  if (date && (since || until)) throw new Error('Use --date with optional --start/--end, or --since/--until; do not combine them.')
  if ((start || end) && !date) throw new Error('Use --start/--end together with --date.')
  if (date) {
    const range = reviewDateRange(date, { nowSeconds, timeZone })
    const resolvedSince = start ? epochForLocalTime(range.localDate, start, timeZone) : range.since
    const requestedUntil = end ? epochForLocalTime(range.localDate, end, timeZone) : range.until
    const resolvedUntil = Math.min(requestedUntil, nowSeconds)
    if (resolvedSince >= resolvedUntil) throw new Error('The review window must start before it ends.')
    return { ...range, since: resolvedSince, until: resolvedUntil }
  }
  const resolvedSince = since ? explicitBoundary(since, { nowSeconds, timeZone }) : reviewDateRange('today', { nowSeconds, timeZone }).since
  const resolvedUntil = until ? explicitBoundary(until, { nowSeconds, timeZone, endOfDay: true }) : nowSeconds
  if (resolvedSince >= resolvedUntil) throw new Error('The review window must start before it ends.')
  return {
    label: since || 'today',
    localDate: null,
    since: resolvedSince,
    until: resolvedUntil,
    timeZone,
  }
}

function normalizeReviewWords(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
}

function termsForMessage(message, terms) {
  const text = ` ${normalizeReviewWords(message.text)} `
  return terms.filter((term) => text.includes(` ${term.words} `)).map((term) => term.value)
}

export function selectConversationReview(messages, { since, until, terms = [], mode = 'any', from = 'any', context = 4 } = {}) {
  if (!Number.isFinite(since) || !Number.isFinite(until)) throw new Error('A bounded review window is required.')
  if (!['any', 'all'].includes(mode)) throw new Error('Review mode must be any or all.')
  if (!['any', 'incoming', 'me'].includes(from)) throw new Error('Review sender must be any, incoming or me.')
  if (!Number.isInteger(context) || context < 0 || context > 50) throw new Error('Review context must be between 0 and 50 messages.')
  const normalizedTerms = terms.map((value) => ({
    value,
    words: normalizeReviewWords(value),
  })).filter((term) => term.words)
  const windowMessages = [...(messages || [])]
    .filter((message) => Number(message.timestamp) >= since && Number(message.timestamp) <= until)
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
  const matches = windowMessages.map((message, index) => {
    const matchedTerms = termsForMessage(message, normalizedTerms)
    const directionMatches = from === 'any' || (from === 'me' ? Boolean(message.fromMe) : !message.fromMe)
    const matched = directionMatches && (normalizedTerms.length === 0
      || (mode === 'all' ? matchedTerms.length === normalizedTerms.length : matchedTerms.length > 0)
    )
    return { index, message, matched, matchedTerms }
  })
  const matching = matches.filter((entry) => entry.matched)
  const selectedIndexes = new Set()
  for (const match of matching) {
    const start = normalizedTerms.length ? Math.max(0, match.index - context) : match.index
    const end = normalizedTerms.length ? Math.min(windowMessages.length - 1, match.index + context) : match.index
    for (let index = start; index <= end; index += 1) selectedIndexes.add(index)
  }
  const matchById = new Map(matching.map((entry) => [entry.message.id, entry.matchedTerms]))
  const timeline = windowMessages
    .filter((_, index) => selectedIndexes.has(index))
    .map((message) => ({ ...message, review: { isMatch: matchById.has(message.id), matchedTerms: matchById.get(message.id) || [] } }))
  const media = timeline
    .filter((message) => ['audioMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(message.type))
    .map((message) => ({
      id: message.id,
      timestamp: message.timestamp,
      fromMe: Boolean(message.fromMe),
      type: message.type,
      available: Boolean(message.audioRef || message.imageRef || message.videoRef || message.documentRef || message.stickerRef),
    }))
  return {
    windowMessages,
    matching,
    timeline,
    media,
  }
}
