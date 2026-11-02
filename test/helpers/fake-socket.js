import { EventEmitter } from 'node:events'

// A minimal stand-in for the Baileys socket surface used by verified sends.
// Like Baileys, sendMessage resolves even when the recipient has no device:
// that is exactly the behavior the bridge must not trust.
//
// devices: { [jid]: number } recipient devices returned by getUSyncDevices
// mapping: { [jid]: jid } LID ↔ PN equivalents known to Baileys
// ack: 'ok' | 'error' | 'none' | 'close' server response to each send
// uploadMs / uploadError: attachment upload, which Baileys runs before relaying
// failBeforeSend / failAfterSend: an error thrown before the stanza is written,
//   or after it was written (for example, persisting Signal keys)
// ackDelayMs: server ack latency after the stanza is written
export function fakeSocket({ devices = {}, mapping = {}, ack = 'ok', ackError = '479', ackAt = 1793620804, uploadMs = 0, uploadError = null, failBeforeSend = null, failAfterSend = null, ackDelayMs = 0 } = {}) {
  const ws = new EventEmitter()
  const sends = []
  const deviceQueries = []
  const socket = {
    user: { id: '59800000001:7@s.whatsapp.net', lid: '880000000001:7@lid' },
    ws,
    sends,
    deviceQueries,
    signalRepository: {
      lidMapping: {
        getPNForLID: async (jid) => (jid.endsWith('@lid') ? mapping[jid] || null : null),
        getLIDForPN: async (jid) => (jid.endsWith('@s.whatsapp.net') ? mapping[jid] || null : null),
      },
    },
    getUSyncDevices: async (jids, useCache) => {
      deviceQueries.push({ jids, useCache })
      return jids.flatMap((jid) => {
        const user = jid.replace(/[:@].*$/, '')
        return Array.from({ length: devices[jid] || 0 }, (_, device) => ({ user, device, jid: `${user}:${device}@${jid.split('@')[1]}` }))
      })
    },
    uploads: 0,
    waUploadToServer: async () => {
      socket.uploads += 1
      await new Promise((resolve) => setTimeout(resolve, uploadMs))
      if (uploadError) throw new Error(uploadError)
      return { mediaUrl: 'https://example.invalid/media', directPath: '/media' }
    },
    sendMessage: async (jid, content, options = {}) => {
      const id = options.messageId || `3EB0FAKE${sends.length}`
      // Like generateWAMessage: media is uploaded through options.upload first.
      if (content.document || content.image || content.video || content.audio) await (options.upload || socket.waUploadToServer)('/tmp/encrypted-media', { mediaType: 'document' })
      if (failBeforeSend) throw new Error(failBeforeSend)
      sends.push({ jid, content, options: { ...options, messageId: id } })
      setTimeout(() => {
        if (ack === 'ok') ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id, from: jid, t: String(ackAt) } })
        if (ack === 'error') ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id, from: jid, error: ackError } })
        if (ack === 'close') ws.emit('close')
      }, ackDelayMs)
      if (failAfterSend) throw new Error(failAfterSend)
      return { key: { remoteJid: jid, id, fromMe: true }, message: content }
    },
  }
  return socket
}

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
