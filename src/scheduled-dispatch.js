import { DEFAULT_MAX_DELIVERY_DELAY_MS } from './scheduled-messages.js'

// The dispatcher deliberately treats every send error as ambiguous. WhatsApp
// may have accepted a node before Baileys reports a timeout or disconnect, so
// automatic retry would risk duplicate private messages.
export async function dispatchScheduledMessages({ queue, canSend, resolveJid, send, logger, maxMessages = 10, maxDelayMs = DEFAULT_MAX_DELIVERY_DELAY_MS }) {
  const expired = await queue.expireOverdue({ maxDelayMs })
  if (!canSend()) return { expired, sent: [], uncertain: [], failed: [] }
  const sent = []
  const uncertain = []
  const failed = []
  for (let count = 0; count < maxMessages; count += 1) {
    const message = await queue.claimDue()
    if (!message) break
    try {
      const jid = await resolveJid(message.originalJid || message.jid)
      if (!jid) throw new Error('The recipient could not be resolved to a current WhatsApp chat.')
      const result = await send(message, jid)
      if (result.pending) {
        const updated = await queue.uncertain(message.id, result.requestId)
        uncertain.push(updated)
        logger.error({ scheduledMessageId: message.id }, 'Scheduled send result is uncertain; it was not retried')
        continue
      }
      const updated = await queue.complete(message.id, result)
      sent.push(updated)
      logger.info({ scheduledMessageId: message.id, messageId: result.id }, 'Sent scheduled WhatsApp message')
    } catch (error) {
      const updated = await queue.uncertain(message.id, message.requestId, error)
      uncertain.push(updated)
      logger.error({ err: error, scheduledMessageId: message.id }, 'Scheduled send failed with an ambiguous result; it was not retried')
    }
  }
  return { expired, sent, uncertain, failed }
}
