import { DEFAULT_MAX_DELIVERY_DELAY_MS, MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS } from './scheduled-messages.js'
import { DeliveryError, isDeliveryError } from './verified-send.js'

// The identity to deliver a scheduled entry to, decided at send time rather
// than when it was scheduled: an alias is looked up again (its number may have
// changed), a phone JID is later resolved to the current LID by the bridge,
// and a LID or group is used as is. A LID is never reinterpreted as a phone
// number. Returns { phoneJid } for the bridge to resolve, or { jid }.
export function scheduledRecipient(message, aliases = {}) {
  if (message.jid?.endsWith('@g.us')) return { jid: message.jid }
  const alias = message.alias ? aliases?.[message.alias] : null
  const aliasPhone = typeof alias?.phone === 'string' ? alias.phone.replace(/\D/g, '') : ''
  if (aliasPhone) return { phoneJid: `${aliasPhone}@s.whatsapp.net` }
  if (message.originalJid?.endsWith('@s.whatsapp.net')) return { phoneJid: message.originalJid }
  return { jid: message.jid }
}

// Only a send WhatsApp confirmed counts as sent. A failure where nothing left
// this device (no recipient device, unresolvable recipient) follows a bounded
// retry policy inside the delivery window; a send WhatsApp rejected is failed;
// anything ambiguous (timeout, disconnect, missing server ack, interrupted
// request) becomes uncertain and is never retried automatically, because a
// duplicate private message is worse than a visible uncertain state.
// Every failed, uncertain or expired entry is passed to notify().
export async function dispatchScheduledMessages({
  queue, canSend, resolveRecipient, send, logger, notify = () => {},
  maxMessages = 10, maxDelayMs = DEFAULT_MAX_DELIVERY_DELAY_MS,
  maxAttempts = MAX_DELIVERY_ATTEMPTS, retryDelaysMs = RETRY_DELAYS_MS,
}) {
  const alert = (message) => {
    try {
      Promise.resolve(notify(message)).catch((error) => logger.error({ err: error, scheduledMessageId: message.id }, 'Could not deliver a scheduled-message alert'))
    } catch (error) {
      logger.error({ err: error, scheduledMessageId: message.id }, 'Could not deliver a scheduled-message alert')
    }
  }
  const expired = await queue.expireOverdue({ maxDelayMs })
  for (const message of expired) {
    logger.error({ scheduledMessageId: message.id, status: message.status }, 'Scheduled message left its delivery window without being sent')
    alert(message)
  }
  const result = { expired, sent: [], uncertain: [], failed: [], retrying: [] }
  if (!canSend()) return result
  for (let count = 0; count < maxMessages; count += 1) {
    const message = await queue.claimDue()
    if (!message) break
    try {
      const jid = await resolveRecipient(message)
      if (!jid) throw new DeliveryError('recipient_unresolved', 'The recipient could not be resolved to a current WhatsApp chat; nothing was sent.', { retryable: true })
      const outcome = await send(message, jid)
      if (outcome?.pending) {
        const updated = await queue.uncertain(message.id, outcome.requestId)
        result.uncertain.push(updated)
        logger.error({ scheduledMessageId: message.id }, 'Scheduled send result is uncertain; it was not retried')
        alert(updated)
        continue
      }
      if (!outcome?.sent || !outcome.id) throw new DeliveryError('unconfirmed_result', 'The send returned no WhatsApp confirmation; it was not retried.', { ambiguous: true })
      const updated = await queue.complete(message.id, outcome)
      result.sent.push(updated)
      logger.info({ scheduledMessageId: message.id, messageId: outcome.id, jid: outcome.delivery?.jid }, 'Sent scheduled WhatsApp message')
    } catch (error) {
      if (isDeliveryError(error) && !error.ambiguous) {
        const updated = await queue.failAttempt(message.id, error, { retryable: error.retryable, maxAttempts, retryDelaysMs, maxDelayMs })
        if (updated.status === 'failed') {
          result.failed.push(updated)
          logger.error({ err: error, scheduledMessageId: message.id, code: error.code }, 'Scheduled message failed; nothing was delivered')
          alert(updated)
        } else {
          result.retrying.push(updated)
          logger.warn({ err: error, scheduledMessageId: message.id, code: error.code, nextAttemptAt: updated.nextAttemptAt }, 'Scheduled message was not sent; it will be retried')
        }
        continue
      }
      const updated = await queue.uncertain(message.id, message.requestId, error)
      result.uncertain.push(updated)
      logger.error({ err: error, scheduledMessageId: message.id }, 'Scheduled send failed with an ambiguous result; it was not retried')
      alert(updated)
    }
  }
  return result
}
