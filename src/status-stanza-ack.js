import { buildAckStanza } from 'baileys'

// WhatsApp is rolling out a new transport for contacts' status updates
// (stories): a top-level <status> stanza instead of
// <message from="status@broadcast">. Baileys 7.0.0-rc14 registers no handler
// for it, so the stanza is never acked. The server then:
//   - holds this connection's offline queue behind the unacked stanza, so the
//     backlog drains one or two messages per connection and <ib><offline>
//     (receivedPendingNotifications) never arrives;
//   - ~50 minutes later ends the stream with
//     <stream:error><ack class="status" type="media|text" id="…"/></stream:error>
//     (500, "Stream Errored (ack)") and redelivers the same stanza on reconnect.
// Upstream: WhiskeySockets/Baileys#2858, fix proposed in #2866, unreleased as
// of rc14. whatsmeow acks the same stanza (tulir/whatsmeow@a238105488).
//
// The bridge only sends the transport ack Baileys sends for every other
// stanza, built by Baileys' own buildAckStanza and written through the
// socket's public sendNode: class="status", same id/type/participant/
// recipient, no error code (a NACK keeps the stanza pending on the server).
// An ack is not a receipt: it does not mark the status as seen and nothing is
// sent to the contact. The status content is not ingested.
//
// Remove this module once Baileys ships its own CB:status handler; until then
// the guard below steps aside automatically if one is registered.
export const STATUS_STANZA_EVENT = 'CB:status'

export function baileysHandlesStatusStanzas(socket) {
  return (socket?.ws?.listenerCount?.(STATUS_STANZA_EVENT) || 0) > 0
}

export function ackStatusStanzas(socket, { logger = null, onAck = null } = {}) {
  if (!socket?.ws?.on || typeof socket.sendNode !== 'function') return false
  if (baileysHandlesStatusStanzas(socket)) return false
  socket.ws.on(STATUS_STANZA_EVENT, (node) => {
    if (!node?.attrs?.id) return
    Promise.resolve()
      .then(() => socket.sendNode(buildAckStanza(node)))
      .then(() => onAck?.(node))
      .catch((error) => logger?.warn?.({ err: error, stanzaType: node.attrs.type || null, offline: Boolean(node.attrs.offline) }, 'Could not ack a status stanza'))
  })
  return true
}
