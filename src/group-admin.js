// Group administration the owner asks for explicitly: creating a group and
// setting its photo. Creating is an external side effect, like a send. The
// bridge only validates requests structurally and reports what WhatsApp
// actually did, including requested people it did not add (for example,
// because their privacy settings only allow an invitation).

export const GROUP_SUBJECT_MAX_LENGTH = 100
// WhatsApp groups hold up to 1024 members, the creator included.
export const GROUP_CREATE_MAX_PARTICIPANTS = 1023

const PARTICIPANT_JID = /^\d+@(s\.whatsapp\.net|lid)$/

// Baileys crops and scales the photo to 640×640 JPEG (sharp) before upload.
export const GROUP_PHOTO_MAX_BYTES = 16 * 1024 * 1024
const GROUP_PHOTO_EXTENSION = /\.(jpe?g|png|webp)$/i
const GROUP_JID = /^[\d-]+@g\.us$/

export function isGroupPhotoFile(filePath) {
  return typeof filePath === 'string' && GROUP_PHOTO_EXTENSION.test(filePath)
}

export function validateGroupPhoto({ jid, filePath } = {}) {
  if (typeof jid !== 'string' || !GROUP_JID.test(jid)) return { error: 'invalid_group_jid' }
  if (typeof filePath !== 'string' || !filePath.startsWith('/') || !isGroupPhotoFile(filePath)) return { error: 'invalid_group_photo' }
  return { jid, filePath }
}

// Who can add participants. Groups the owner creates default to everyone,
// so any member can bring in a colleague without waiting for an admin.
export const MEMBER_ADD_MODES = { all: 'all_member_add', admins: 'admin_add' }

export function memberAddModeFor(value) {
  if (Object.values(MEMBER_ADD_MODES).includes(value)) return value
  return MEMBER_ADD_MODES[value] || null
}

export function validateMemberAddMode({ jid, mode } = {}) {
  if (typeof jid !== 'string' || !GROUP_JID.test(jid)) return { error: 'invalid_group_jid' }
  const memberAddMode = memberAddModeFor(mode)
  if (!memberAddMode) return { error: 'invalid_member_add_mode' }
  return { jid, mode: memberAddMode }
}

export function isGroupParticipantJid(jid) {
  return typeof jid === 'string' && PARTICIPANT_JID.test(jid)
}

export function validateGroupCreate({ subject, participants, memberAddMode } = {}) {
  const name = typeof subject === 'string' ? subject.trim() : ''
  if (memberAddMode != null && !memberAddModeFor(memberAddMode)) return { error: 'invalid_member_add_mode' }
  if (!name || [...name].length > GROUP_SUBJECT_MAX_LENGTH) return { error: 'invalid_group_subject' }
  if (!Array.isArray(participants) || !participants.length || !participants.every(isGroupParticipantJid)) return { error: 'invalid_group_participants' }
  const unique = [...new Set(participants)]
  if (unique.length > GROUP_CREATE_MAX_PARTICIPANTS) return { error: 'invalid_group_participants' }
  return { subject: name, participants: unique, memberAddMode: memberAddMode == null ? null : memberAddModeFor(memberAddMode) }
}

// A timeout or a closed connection can arrive after WhatsApp already created
// the group, so it must never be repeated blindly. An error answered by
// WhatsApp itself (bad request, not authorized…) is a confirmed failure.
export function markAmbiguousCreateFailure(error) {
  const status = error?.output?.statusCode
  if (error && typeof error === 'object' && (status == null || status === 408 || status === 428)) error.ambiguous = true
  return error
}

// WhatsApp answers bad-request when a group is created with LID participants
// (verified 2026-11-06): creation must address each person by phone JID. Use
// the phone equivalent the bridge's LID mapping knows; never derive one from
// LID digits. Without a known equivalent the JID is sent as is and WhatsApp's
// answer is reported.
export function creationParticipants(requested) {
  return [...new Set(requested.map(({ jid, aliases }) => (jid.endsWith('@s.whatsapp.net') ? jid : (aliases || []).find((alias) => alias.endsWith('@s.whatsapp.net')) || jid)))]
}

// requested: [{ jid, aliases }] where aliases holds the jid and its known
// phone/LID equivalent, so a participant returned under the other identity
// still counts as added. The bridge passes Baileys' jidNormalizedUser so a
// device-qualified JID compares equal; the CLI never imports Baileys.
export function createdGroupSummary(metadata, requested = [], normalizeJid = (jid) => jid) {
  const normalized = (jid) => {
    try {
      return normalizeJid(jid) || jid
    } catch {
      return jid
    }
  }
  const participants = (metadata?.participants || []).map((participant) => ({
    jid: participant.id,
    phoneNumber: participant.phoneNumber || null,
    lid: participant.lid || null,
    admin: participant.admin || null,
  }))
  const present = new Set(participants.flatMap((participant) => [participant.jid, participant.phoneNumber, participant.lid].filter(Boolean).map(normalized)))
  const notAdded = requested
    .filter(({ jid, aliases }) => ![jid, ...(aliases || [])].some((alias) => present.has(normalized(alias))))
    .map(({ jid }) => jid)
  return { jid: metadata?.id || null, subject: metadata?.subject || null, participants, notAdded }
}
