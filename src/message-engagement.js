function unixSeconds(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function voteTimestamp(value) {
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1000) : null
}

export function normalizedReceipts(userReceipt = []) {
  const receipts = {}
  for (const receipt of userReceipt || []) {
    const participant = receipt?.userJid
    if (!participant) continue
    receipts[participant] = {
      deliveredAt: unixSeconds(receipt.receiptTimestamp),
      readAt: unixSeconds(receipt.readTimestamp),
      playedAt: unixSeconds(receipt.playedTimestamp),
    }
  }
  return receipts
}

export function reactionActor(reaction) {
  const key = reaction?.key || {}
  // In groups Baileys supplies participant. In a direct chat remoteJid is the
  // other account; use a stable local marker for a reaction sent by this account.
  return key.participant || (key.fromMe ? 'self' : key.remoteJid || null)
}

export function normalizedReactions(reactions = []) {
  const byActor = new Map()
  for (const reaction of reactions || []) {
    const participant = reactionActor(reaction)
    if (!participant) continue
    if (!reaction.text) {
      byActor.delete(participant)
      continue
    }
    byActor.set(participant, {
      participant,
      emoji: reaction.text,
      timestamp: unixSeconds(reaction.senderTimestampMs) ? Math.floor(Number(reaction.senderTimestampMs) / 1000) : null,
    })
  }
  return [...byActor.values()]
}

export function applyReceipt(message, receipt) {
  const participant = receipt?.userJid
  if (!message || !participant) return false
  const previous = message.receipts?.[participant] || {}
  const next = {
    deliveredAt: unixSeconds(receipt.receiptTimestamp) || previous.deliveredAt || null,
    readAt: unixSeconds(receipt.readTimestamp) || previous.readAt || null,
    playedAt: unixSeconds(receipt.playedTimestamp) || previous.playedAt || null,
  }
  if (previous.deliveredAt === next.deliveredAt && previous.readAt === next.readAt && previous.playedAt === next.playedAt) return false
  message.receipts = { ...(message.receipts || {}), [participant]: next }
  return true
}

export function applyReaction(message, reaction) {
  if (!message) return false
  const participant = reactionActor(reaction)
  if (!participant) return false
  const reactions = (message.reactions || []).filter((item) => item.participant !== participant)
  if (reaction.text) {
    reactions.push({
      participant,
      emoji: reaction.text,
      timestamp: unixSeconds(reaction.senderTimestampMs) ? Math.floor(Number(reaction.senderTimestampMs) / 1000) : null,
    })
  }
  const previous = JSON.stringify(message.reactions || [])
  const next = JSON.stringify(reactions)
  if (previous === next) return false
  message.reactions = reactions
  return true
}

export function applyDirectStatus(message, status, statusAt, fallbackAt) {
  const nextStatus = Number(status)
  if (!message || !Number.isFinite(nextStatus)) return false
  const previousStatus = Number(message.status)
  // WhatsApp can replay an older SERVER_ACK after reconnecting. Delivery states
  // only move forward for a concrete message; do not let a replay erase a
  // previously observed delivery/read/played confirmation.
  if (Number.isFinite(previousStatus) && nextStatus <= previousStatus) return false
  message.status = nextStatus
  message.statusAt = unixSeconds(statusAt) || fallbackAt
  return true
}

export function applyPollVote(message, { participant, options, senderTimestampMs }) {
  if (!message?.poll || !participant) return false
  const votes = (message.pollVotes || []).filter((vote) => vote.participant !== participant)
  if (options?.length) votes.push({ participant, options, timestamp: voteTimestamp(senderTimestampMs) })
  const previous = JSON.stringify(message.pollVotes || [])
  const next = JSON.stringify(votes)
  if (previous === next) return false
  message.pollVotes = votes
  return true
}

export function receiptReport({ message, participants = [] }) {
  const receipts = Object.entries(message?.receipts || {}).map(([participant, receipt]) => ({ participant, ...receipt }))
  const reported = new Set(receipts.filter((receipt) => receipt.readAt).map((receipt) => receipt.participant))
  return {
    receipts,
    readBy: [...reported],
    notReportedReadBy: participants.filter((participant) => !reported.has(participant)),
    note: 'La ausencia de un read receipt no prueba que la persona no lo haya visto: WhatsApp puede no reportarlo por privacidad, conectividad o porque el bridge no estaba conectado.',
  }
}
