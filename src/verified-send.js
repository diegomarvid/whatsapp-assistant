import { generateMessageIDV2, jidDecode, jidNormalizedUser } from 'baileys'

// A WhatsApp send must never be reported beyond what WhatsApp confirmed.
// Baileys' sendMessage resolves as soon as the stanza is written to the
// socket, even when it was encrypted for zero recipient devices: an unknown
// phone number, or a LID whose devices could not be resolved, produces a
// silent "success" that reaches nobody. Every new outbound message therefore
// goes through this one path:
//
// 1. Before sending to a direct chat, ask Baileys for the recipient's devices.
//    With none, try the equivalent phone/LID identity from Baileys' own
//    LID↔PN mapping. With none there either, fail without sending anything.
// 2. Send with a reserved message ID and wait for WhatsApp's server ack for
//    exactly that ID. An error ack is a definitive failure; a missing ack, or
//    an error that may have come after the stanza was written, is ambiguous
//    and must never be retried automatically.
//
// It uses only public Baileys surface (pinned in baileys-contract.test.js):
// getUSyncDevices, the LID mapping store and the socket's frame events.

export const SERVER_ACK_TIMEOUT_MS = 15_000
const ACK_EVENT = 'CB:ack,class:message'

export class DeliveryError extends Error {
  // retryable: nothing left this device, so a later attempt cannot duplicate.
  // ambiguous: WhatsApp may have accepted the message; never retry blindly.
  constructor(code, message, { retryable = false, ambiguous = false, details = {} } = {}) {
    super(message)
    this.name = 'DeliveryError'
    this.code = code
    this.retryable = retryable
    this.ambiguous = ambiguous
    this.details = details
  }
}

export function isDeliveryError(error) {
  return error instanceof DeliveryError
}

function userOf(jid) {
  try { return jidDecode(jid)?.user || null } catch { return null }
}

export function isDirectJid(jid) {
  return typeof jid === 'string' && /@(s\.whatsapp\.net|lid)$/.test(jid)
}

function ownUsers(socket) {
  const users = new Set()
  for (const id of [socket.user?.id, socket.user?.lid]) {
    const user = id && userOf(id)
    if (user) users.add(user)
  }
  return users
}

async function countRecipientDevices(socket, jid, own) {
  const count = (devices) => (devices || []).filter((device) => device?.user && !own.has(device.user)).length
  try {
    const cached = count(await socket.getUSyncDevices([jid], true, false))
    if (cached > 0) return cached
    // A cached device list can be stale; one fresh query before giving up.
    return count(await socket.getUSyncDevices([jid], false, false))
  } catch (error) {
    // The lookup happens before sending, so its failure is safe to retry.
    throw new DeliveryError('device_lookup_failed', `Could not look up WhatsApp devices for ${jid} (${error.message}); nothing was sent.`, { retryable: true, details: { jid } })
  }
}

async function equivalentIdentity(socket, jid, logger) {
  const mapping = socket.signalRepository?.lidMapping
  try {
    if (jid.endsWith('@lid') && mapping?.getPNForLID) {
      const phone = await mapping.getPNForLID(jid)
      return phone ? jidNormalizedUser(phone) : null
    }
    if (jid.endsWith('@s.whatsapp.net') && mapping?.getLIDForPN) {
      const lid = await mapping.getLIDForPN(jid)
      return lid ? jidNormalizedUser(lid) : null
    }
  } catch (error) {
    logger?.warn?.({ err: error, jid }, 'Could not resolve the equivalent WhatsApp identity')
  }
  return null
}

// Chooses the identity to send to. Groups and the account's own chat keep
// Baileys' normal device fan-out; a direct contact must have a device.
export async function deliverableRecipient(socket, jid, { logger } = {}) {
  if (!isDirectJid(jid)) return { jid, recipientDevices: null, fallbackFrom: null }
  const own = ownUsers(socket)
  if (own.has(userOf(jid))) return { jid, recipientDevices: null, fallbackFrom: null }
  const devices = await countRecipientDevices(socket, jid, own)
  if (devices > 0) return { jid, recipientDevices: devices, fallbackFrom: null }
  const equivalent = await equivalentIdentity(socket, jid, logger)
  if (equivalent && equivalent !== jid && !own.has(userOf(equivalent))) {
    const equivalentDevices = await countRecipientDevices(socket, equivalent, own)
    if (equivalentDevices > 0) {
      logger?.warn?.({ jid, equivalent }, 'Recipient had no devices; sending to its equivalent WhatsApp identity')
      return { jid: equivalent, recipientDevices: equivalentDevices, fallbackFrom: jid }
    }
  }
  throw new DeliveryError(
    'no_recipient_devices',
    `WhatsApp returned no device for ${jid}${equivalent ? ` nor for its equivalent ${equivalent}` : ' and no equivalent phone/LID is known'}; nothing was sent.`,
    { retryable: true, details: { jid, equivalent } },
  )
}

// The ack listener is registered before calling sendMessage so an early ack is
// never missed, but its countdown only starts once sendMessage has settled:
// preparing and uploading an attachment can take longer than the ack window,
// and that time must not count against WhatsApp's answer to the real send.
function watchServerAck(socket, messageId) {
  const ws = socket.ws
  let settled = null
  let timer = null
  let resolveOutcome
  const outcome = new Promise((resolve) => { resolveOutcome = resolve })
  const cleanup = () => {
    clearTimeout(timer)
    ws.off(ACK_EVENT, onAck)
    ws.off('close', onClose)
  }
  const finish = (value) => {
    if (settled) return
    settled = value
    cleanup()
    resolveOutcome(value)
  }
  function onAck(node) {
    if (node?.attrs?.id !== messageId) return
    finish({ status: node.attrs.error ? 'error' : 'ack', error: node.attrs.error || null, at: Number(node.attrs.t) || null })
  }
  function onClose() { finish({ status: 'closed' }) }
  ws.on(ACK_EVENT, onAck)
  ws.on('close', onClose)
  return {
    wait(timeoutMs) {
      if (!settled) timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)
      return outcome
    },
    cancel() { finish({ status: 'cancelled' }) },
  }
}

// Returns a compact, JSON-safe confirmation: { key, delivery }. The key keeps
// the shape every caller already reads (result.key.id).
//
// Only two failures prove that nothing left this device: the recipient check
// above and an attachment upload that failed (Baileys uploads before it
// relays). Any other error from sendMessage may have happened after the
// stanza was written (for example, persisting Signal keys after the send), so
// the outcome is decided by WhatsApp's ack: an ack means it was sent, an
// error ack means it was rejected, and no ack is ambiguous. An ambiguous
// result never releases a retry.
export async function verifiedSend({ socket, jid, content, options = {}, ackTimeoutMs = SERVER_ACK_TIMEOUT_MS, logger, now = () => Date.now() }) {
  const recipient = await deliverableRecipient(socket, jid, { logger })
  const messageId = options.messageId || generateMessageIDV2(socket.user?.id)
  const ack = watchServerAck(socket, messageId)
  let uploadFailed = false
  // Wraps Baileys' own uploader (sendMessage forwards per-call options to
  // message generation) only to learn that a failure happened during upload.
  const upload = typeof socket.waUploadToServer === 'function'
    ? async (...args) => {
      try {
        return await socket.waUploadToServer(...args)
      } catch (error) {
        uploadFailed = true
        throw error
      }
    }
    : undefined
  let message = null
  let sendError = null
  try {
    message = await socket.sendMessage(recipient.jid, content, { ...options, ...(upload ? { upload } : {}), messageId })
  } catch (error) {
    sendError = error
  }
  if (sendError && uploadFailed) {
    ack.cancel()
    throw new DeliveryError('upload_failed', `Could not upload the attachment (${sendError.message}); nothing was sent.`, { retryable: true, details: { jid: recipient.jid } })
  }
  const outcome = await ack.wait(ackTimeoutMs)
  const delivery = {
    jid: recipient.jid,
    requestedJid: jid,
    fallbackFrom: recipient.fallbackFrom,
    recipientDevices: recipient.recipientDevices,
    serverAckAt: null,
  }
  if (outcome.status === 'error') {
    throw new DeliveryError('server_rejected', `WhatsApp rejected message ${messageId} (server error ${outcome.error}); it was not delivered.`, {
      details: { ...delivery, messageId, serverError: outcome.error },
    })
  }
  if (outcome.status !== 'ack') {
    const waited = outcome.status === 'closed' ? ' before the connection closed' : ` within ${Math.round(ackTimeoutMs / 1000)} s`
    const cause = sendError ? `Sending message ${messageId} failed after it may have left this device (${sendError.message}) and WhatsApp did not acknowledge it${waited}` : `WhatsApp did not acknowledge message ${messageId}${waited}`
    throw new DeliveryError(sendError ? 'send_interrupted' : 'no_server_ack', `${cause}; it may or may not have been delivered and was not retried.`, {
      ambiguous: true,
      details: { ...delivery, messageId },
    })
  }
  if (sendError) logger?.warn?.({ err: sendError, messageId }, 'Baileys reported an error after WhatsApp acknowledged the message; it counts as sent')
  delivery.serverAckAt = outcome.at || Math.floor(now() / 1000)
  return {
    key: { remoteJid: message?.key?.remoteJid || recipient.jid, id: message?.key?.id || messageId, fromMe: true },
    delivery,
  }
}
