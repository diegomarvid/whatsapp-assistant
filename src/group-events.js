// Baileys emits one group-participants.update object, not an array. Normalize
// that boundary here; participants in current releases carry their JID in id.
export function applyGroupParticipantUpdates(updates, appendGroupEvent) {
  let changed = false
  for (const update of Array.isArray(updates) ? updates : [updates]) {
    if (!update?.id || !Array.isArray(update.participants)) continue
    for (const value of update.participants) {
      const participant = typeof value === 'string' ? value : value?.id
      if (typeof participant !== 'string' || !participant) continue
      changed = appendGroupEvent({
        groupJid: update.id,
        kind: 'participant',
        action: update.action || null,
        participant,
        author: update.author || null,
      }) || changed
    }
  }
  return changed
}
