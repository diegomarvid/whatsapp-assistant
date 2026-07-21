import { linksInText } from './message-normalizer.js'

export function formatTime(timestamp) {
  return new Intl.DateTimeFormat('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' }).format(new Date(timestamp * 1000))
}

export function contactIdentity(jid, contacts = {}) {
  const name = jid === 'self' ? 'Vos' : contacts[jid]?.name || null
  return { jid, name }
}

export function groupReceiptReport(message, group, contacts) {
  const selfJid = group.selfJid || null
  const participants = (group.participants || []).map((participant) => participant.jid).filter((jid) => jid && jid !== selfJid)
  const receipts = Object.entries(message.receipts || {}).map(([participant, receipt]) => ({ participant: contactIdentity(participant, contacts), ...receipt }))
  const readBy = new Set(Object.entries(message.receipts || {}).filter(([, receipt]) => receipt.readAt).map(([participant]) => participant))
  return {
    message: { id: message.id, timestamp: message.timestamp, fromMe: message.fromMe, type: message.type },
    participantCount: participants.length,
    receipts,
    readBy: receipts.filter((receipt) => receipt.readAt).map((receipt) => receipt.participant),
    withoutReportedReadReceipt: participants.filter((participant) => !readBy.has(participant)).map((participant) => contactIdentity(participant, contacts)),
    note: 'withoutReportedReadReceipt no significa que la persona no lo vio: WhatsApp puede no enviar el receipt por privacidad, conectividad o porque el bridge no estaba conectado.',
  }
}

export function pollReport(message, contacts) {
  const votes = message.pollVotes || []
  return {
    id: message.id,
    timestamp: message.timestamp,
    question: message.poll?.question || null,
    options: (message.poll?.options || []).map((option) => ({
      option,
      voters: votes.filter((vote) => vote.options?.includes(option)).map((vote) => ({ ...contactIdentity(vote.participant, contacts), timestamp: vote.timestamp || null })),
    })),
    note: 'Sólo incluye votos que el bridge pudo descifrar y observar desde que estaba conectado.',
  }
}

export function linksForMessage(message) {
  return Array.isArray(message.links) && message.links.length ? message.links : linksInText(message.text)
}

function chatLabel(jid, cache) {
  const name = cache?.contacts?.[jid]?.name || cache?.chats?.[jid]?.name || null
  return name ? `${name} (${jid})` : jid
}

export function printMessages(messages, { ids = false, cache = null, empty = 'No hay mensajes cacheados para este chat.' } = {}) {
  if (!messages.length) return console.log(empty)
  for (const message of [...messages].sort((a, b) => a.timestamp - b.timestamp)) {
    const author = message.fromMe ? 'Vos' : message.pushName || 'Contacto'
    const text = message.deleted ? '[mensaje eliminado]' : message.text || `[${message.type}]`
    const structured = message.location ? `ubicación: ${message.location.latitude ?? '?'} , ${message.location.longitude ?? '?'}`
      : message.contacts?.length ? `${message.contacts.length} contacto(s)`
        : message.poll ? `encuesta: ${message.poll.question || 'sin pregunta'}`
          : message.pollUpdate ? `voto de encuesta: ${message.pollUpdate.pollCreationMessageKey || 'sin referencia'}`
            : message.call ? `llamada perdida${message.call.video ? ' de video' : ''}`
              : message.interactiveResponse ? `respuesta interactiva: ${message.interactiveResponse.text || message.interactiveResponse.id || message.interactiveResponse.kind}`
                : null
    const status = message.fromMe && message.status !== null && message.status !== undefined ? `estado ${['error', 'pendiente', 'enviado', 'entregado', 'leído', 'reproducido'][message.status] || message.status}` : null
    const context = [message.quotedMessageId ? `↪ ${message.quotedMessageId}` : null, message.reactionToMessageId ? `reacción ${message.reactionText || ''} a ${message.reactionToMessageId}` : null, message.edited ? 'editado' : null, message.ephemeral ? 'efímero' : null, message.viewOnce ? 'view-once no expuesto' : null, structured, status].filter(Boolean).join(' · ')
    const source = message.source === 'live' ? '' : ' [cache histórico]'
    const chat = cache ? `[${chatLabel(message.jid, cache)}] ` : ''
    console.log(`${chat}${formatTime(message.timestamp)} — ${author}: ${text}${context ? ` (${context})` : ''}${ids ? ` [id: ${message.id}]` : ''}${source}`)
  }
}
