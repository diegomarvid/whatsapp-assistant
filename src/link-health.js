// Link health: is the bridge actually receiving what WhatsApp has for it?
//
// `connection: open` and a handler that never threw are not enough. On
// 2026-11-12 the socket was open and ingestionHealthy stayed true for six
// hours while WhatsApp never finished delivering the offline queue: an
// unacked stanza held it, and the server ended the stream every ~50 minutes.
// Two structural signals catch that state:
//   - offline_queue_not_flushed: WhatsApp did not confirm the end of the
//     offline queue (receivedPendingNotifications) after a grace period of
//     *connected* time, accumulated across reconnects (time asleep never counts);
//   - unacked_stanza_stream_errors: the server ended the stream more than once
//     naming an <ack> it waited for, and the link has not since survived the
//     server's ack timeout.
// The bookkeeping functions return patches for cache.sync; they never read
// message contents.

export const OFFLINE_FLUSH_GRACE_SECONDS = 10 * 60
export const DISCONNECTED_GRACE_SECONDS = 10 * 60
// The server waits ~50 minutes for an ack before ending the stream.
export const SERVER_ACK_TIMEOUT_SECONDS = 55 * 60
export const UNACKED_STREAM_ERROR_WINDOW_SECONDS = 3 * 60 * 60
export const UNACKED_STREAM_ERROR_LOOP = 2
export const ALERT_RETRY_SECONDS = 15 * 60
const DISCONNECT_LOG_SECONDS = 24 * 60 * 60
const DISCONNECT_LOG_MAX = 50
const EVENT_ORDER_TOLERANCE_SECONDS = 5
const ALERT_TIME_ZONE = 'America/Montevideo'

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function connectedAtOf(sync) {
  return positive(sync?.lastConnectedAt || sync?.connectedAt)
}

function flushedForConnection(sync) {
  const connectedAt = connectedAtOf(sync)
  const flushedAt = positive(sync?.pendingNotificationsFlushedAt)
  return Boolean(connectedAt && flushedAt && flushedAt >= connectedAt - EVENT_ORDER_TOLERANCE_SECONDS)
}

export function linkOpened(sync = {}, now) {
  return {
    connectedAt: now,
    lastConnectedAt: now,
    offlineQueuePendingSince: positive(sync.offlineQueuePendingSince) || now,
    offlineQueueUnflushedSeconds: positive(sync.offlineQueueUnflushedSeconds) || 0,
  }
}

export function offlineQueueFlushed(sync = {}, now) {
  return { pendingNotificationsFlushedAt: now, offlineQueuePendingSince: null, offlineQueueUnflushedSeconds: 0 }
}

// Only the stream:error child is kept: its tag, and for an <ack> the class and
// type of the stanza the server was waiting for. No ids, no payloads.
export function disconnectRecord({ at, statusCode = null, error = null }) {
  const record = { at, statusCode: Number.isFinite(statusCode) ? statusCode : null }
  const data = error?.data
  if (data?.tag === 'ack') {
    record.unackedClass = data.attrs?.class || null
    record.unackedType = data.attrs?.type || null
  }
  return record
}

export function linkClosed(sync = {}, now, { statusCode = null, error = null } = {}) {
  const connectedAt = connectedAtOf(sync)
  const lastDisconnectedAt = positive(sync.lastDisconnectedAt)
  // Count this connection's time once, at its first close, if WhatsApp never
  // confirmed the end of the offline queue while it was open.
  const firstCloseOfConnection = connectedAt && !(lastDisconnectedAt && lastDisconnectedAt >= connectedAt)
  let unflushed = positive(sync.offlineQueueUnflushedSeconds) || 0
  if (firstCloseOfConnection && !flushedForConnection(sync)) unflushed += Math.max(0, now - connectedAt)
  const recent = (Array.isArray(sync.recentDisconnects) ? sync.recentDisconnects : [])
    .filter((entry) => Number(entry?.at) >= now - DISCONNECT_LOG_SECONDS)
  return {
    lastDisconnectedAt: now,
    offlineQueueUnflushedSeconds: unflushed,
    recentDisconnects: [...recent, disconnectRecord({ at: now, statusCode, error })].slice(-DISCONNECT_LOG_MAX),
  }
}

export function assessLinkHealth({ connection, sync = {}, now }) {
  const connectedAt = connectedAtOf(sync)
  const open = connection === 'open'
  const flushed = flushedForConnection(sync)
  const accumulated = positive(sync.offlineQueueUnflushedSeconds) || 0
  const unflushedConnectedSeconds = accumulated + (open && !flushed && connectedAt ? Math.max(0, now - connectedAt) : 0)
  const disconnects = (Array.isArray(sync.recentDisconnects) ? sync.recentDisconnects : []).filter((entry) => Number(entry?.at) >= now - DISCONNECT_LOG_SECONDS)
  const unacked = disconnects.filter((entry) => entry.unackedClass && entry.at >= now - UNACKED_STREAM_ERROR_WINDOW_SECONDS)
  const lastUnacked = unacked.at(-1) || null
  const reasons = []
  let pending = false

  if (!open) {
    const since = positive(sync.lastDisconnectedAt) || positive(sync.observerStartedAt)
    if (connection === 'logged_out' || (since && now - since >= DISCONNECTED_GRACE_SECONDS)) reasons.push('bridge_not_connected')
    else pending = true
  } else if (!flushed) {
    if (unflushedConnectedSeconds >= OFFLINE_FLUSH_GRACE_SECONDS) reasons.push('offline_queue_not_flushed')
    else pending = true
  }
  if (unacked.length >= UNACKED_STREAM_ERROR_LOOP) {
    const survivedAckTimeout = open && connectedAt > lastUnacked.at && now - connectedAt >= SERVER_ACK_TIMEOUT_SECONDS
    if (!survivedAckTimeout) reasons.push('unacked_stanza_stream_errors')
  }

  const status = reasons.length ? 'unhealthy' : pending ? 'pending' : 'healthy'
  return {
    status,
    healthy: status === 'healthy',
    reasons,
    checkedAt: now,
    offlineQueue: {
      flushedAt: positive(sync.pendingNotificationsFlushedAt),
      pendingSince: flushed ? null : positive(sync.offlineQueuePendingSince),
      unflushedConnectedSeconds,
    },
    streamErrors: {
      disconnectsLast24h: disconnects.length,
      unackedLast3h: unacked.length,
      lastUnacked,
    },
  }
}

function localTime(seconds, now) {
  if (!positive(seconds)) return 'hora desconocida'
  const parts = (value) => Object.fromEntries(new Intl.DateTimeFormat('es-UY', {
    timeZone: ALERT_TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value * 1000)).map((part) => [part.type, part.value]))
  const at = parts(seconds)
  const today = parts(now)
  const clock = `${at.hour}:${at.minute}`
  return at.day === today.day && at.month === today.month ? clock : `${at.day}/${at.month} ${clock}`
}

function duration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

export function linkAlertMessage(kind, state = {}, health = {}, now) {
  const reasons = health.reasons || []
  let summary
  if (kind === 'recovered') {
    const since = positive(state.openedAt)
    summary = `WhatsApp Assistant: recuperado. La conexión volvió a estar sana y los mensajes entran de nuevo${since ? ` (el aviso se abrió a las ${localTime(since, now)}, hace ${duration(now - since)})` : ''}.`
  } else {
    const sentences = []
    if (reasons.includes('bridge_not_connected')) sentences.push('El bridge no está conectado a WhatsApp.')
    if (reasons.includes('offline_queue_not_flushed')) sentences.push(`WhatsApp no terminó de entregar la cola offline (pendiente desde las ${localTime(health.offlineQueue?.pendingSince, now)}): los mensajes nuevos no entran aunque la conexión figure abierta.`)
    if (reasons.includes('unacked_stanza_stream_errors')) {
      const stanzaClass = health.streamErrors?.lastUnacked?.unackedClass
      sentences.push(`El servidor cortó la conexión ${health.streamErrors?.unackedLast3h || 'varias'} veces en 3 h esperando un ack que el bridge no mandó${stanzaClass ? ` (class=${stanzaClass})` : ''}.`)
    }
    summary = `WhatsApp Assistant: problema de ingesta. ${sentences.join(' ')} Ver: wa doctor`
  }
  return {
    summary,
    payload: {
      version: 1,
      kind: 'link_health',
      state: kind,
      at: now,
      openedAt: positive(state.openedAt),
      reasons,
      offlineQueuePendingSince: positive(health.offlineQueue?.pendingSince),
      unackedStreamErrorsLast3h: health.streamErrors?.unackedLast3h || 0,
    },
  }
}

// One alert when the link becomes unhealthy and one when it is healthy again.
// "pending" (a reconnect still flushing) never opens or closes an alert, so a
// reconnect loop cannot produce a stream of alerts. A failed delivery is
// retried no more than every ALERT_RETRY_SECONDS; a recovery is announced only
// if the opening alert was delivered.
export function planLinkAlert(state = {}, health, now) {
  const current = {
    open: Boolean(state?.open),
    openedAt: positive(state?.openedAt),
    closedAt: positive(state?.closedAt),
    notified: Boolean(state?.notified),
    pending: state?.pending || null,
    nextAttemptAt: positive(state?.nextAttemptAt) || 0,
    reasons: Array.isArray(state?.reasons) ? state.reasons : [],
    lastAlertAt: positive(state?.lastAlertAt),
    lastAlertError: state?.lastAlertError || null,
  }
  if (health.status === 'unhealthy' && !current.open) {
    return { ...current, open: true, openedAt: now, closedAt: null, notified: false, pending: 'opened', nextAttemptAt: 0, reasons: health.reasons }
  }
  if (health.status === 'healthy' && current.open) {
    return { ...current, open: false, closedAt: now, pending: current.notified ? 'recovered' : null, nextAttemptAt: 0, reasons: [] }
  }
  if (current.open && health.status === 'unhealthy') current.reasons = health.reasons
  return current
}

export async function tickLinkAlert({ state, health, now, notify }) {
  const next = planLinkAlert(state, health, now)
  if (!next.pending || now < next.nextAttemptAt) return next
  const kind = next.pending
  try {
    await notify(linkAlertMessage(kind, next, health, now))
    return { ...next, pending: null, notified: kind === 'opened', lastAlertAt: now, lastAlertError: null, nextAttemptAt: 0 }
  } catch (error) {
    return { ...next, nextAttemptAt: now + ALERT_RETRY_SECONDS, lastAlertError: String(error?.message || error).slice(0, 200) }
  }
}
