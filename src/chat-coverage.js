export const DEFAULT_RETENTION_DAYS = 7
// Kept as an alias for callers built against earlier releases.
export const RECENT_RETENTION_DAYS = DEFAULT_RETENTION_DAYS

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function coverageForChat({ chat, messages, connection, sync, retentionDays = DEFAULT_RETENTION_DAYS }) {
  const latestMessageAt = messages.reduce((latest, message) => Math.max(latest, Number(message.timestamp) || 0), 0) || null
  const remoteLatestAt = numberOrNull(chat?.remoteLastTimestamp)
  const connectedAt = numberOrNull(sync?.lastConnectedAt || sync?.connectedAt)
  const lastPersistedAt = numberOrNull(sync?.lastPersistedAt)
  const lastObservedLiveAt = numberOrNull(chat?.lastObservedLiveAt)
  const lastObservedHistoryAt = numberOrNull(chat?.lastObservedHistoryAt)
  // A history-set received after this connection opened is a fresh snapshot
  // from WhatsApp, not merely inherited disk state. The remote cursor check
  // below still rejects it when the returned messages do not reach that cursor.
  const observedAfterConnection = [lastObservedLiveAt, lastObservedHistoryAt]
    .some((observedAt) => observedAt && (!connectedAt || observedAt >= connectedAt))
  // WhatsApp confirms when the offline notification queue of this connection
  // has been fully delivered. After that point, a chat with no new events is
  // genuinely unchanged, not merely unobserved; requiring per-chat activity
  // would wrongly mark every quiet chat stale after each reconnect.
  const offlineQueueFlushedAt = numberOrNull(sync?.pendingNotificationsFlushedAt)
  const offlineQueueDrained = Boolean(offlineQueueFlushedAt && connectedAt && offlineQueueFlushedAt >= connectedAt)
  const reasons = []

  if (connection !== 'open') reasons.push('bridge_not_connected')
  if (sync?.ingestionHealthy === false) reasons.push('ingestion_unhealthy')
  if (!observedAfterConnection && !offlineQueueDrained) reasons.push('chat_not_observed_after_connection')
  if (remoteLatestAt && (!latestMessageAt || remoteLatestAt > latestMessageAt)) reasons.push('remote_chat_ahead_of_cache')

  return {
    status: reasons.length ? (reasons.includes('remote_chat_ahead_of_cache') ? 'stale' : 'unknown') : 'fresh',
    fresh: reasons.length === 0,
    reasons,
    latestMessageAt,
    remoteLatestAt,
    connectedAt,
    lastPersistedAt,
    lastObservedLiveAt,
    lastObservedHistoryAt,
    offlineQueueFlushedAt,
    observerStartedAt: numberOrNull(sync?.observerStartedAt),
    lastDisconnectedAt: numberOrNull(sync?.lastDisconnectedAt),
    retentionDays,
  }
}
