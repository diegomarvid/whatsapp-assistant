import { validateReviewPolicy } from './review-adapter.js'

export const HUMAN_WAITING = new Set(['human_waiting', 'human_ready', 'clarifying', 'human_ack', 'human_resume', 'human_frozen'])
export function withHumanDefaults(policy) {
  return policy && { version: 1, pollSeconds: 5, replyDebounceSeconds: 5, replyMaxWaitSeconds: 20, idleAfterSeconds: 604800, ...policy }
}
export function validateHumanPolicy(policy) {
  if (policy === null) return
  if (!policy || policy.version !== 1) throw new Error('Human consultation policy requires version: 1.')
  validateReviewPolicy({ ...policy, reviewers: policy.responders, expiresSeconds: 604800, maxRevisions: 20 })
  if (!Number.isInteger(policy.replyDebounceSeconds) || policy.replyDebounceSeconds < 0 || policy.replyDebounceSeconds > 300 || !Number.isInteger(policy.replyMaxWaitSeconds) || policy.replyMaxWaitSeconds < policy.replyDebounceSeconds || policy.replyMaxWaitSeconds > 600 || !Number.isInteger(policy.idleAfterSeconds) || policy.idleAfterSeconds < 86400 || policy.idleAfterSeconds > 31536000) throw new Error('Consultation limits: debounce 0–300s, maximum wait up to 600s, idle 1–365 days. Idle parks; it never cancels.')
}

export function validateStoredHuman(batch, policy) {
  const h = batch.human
  if (!h) { if (HUMAN_WAITING.has(batch.status)) throw new Error('Missing persisted consultation.'); return }
  if (h.transportCursor !== undefined && (!Number.isSafeInteger(h.transportCursor) || h.transportCursor < h.cursor)) throw new Error('Malformed consultation transport cursor.')
  if (!policy || !/^[a-f0-9-]{36}$/i.test(h.id || '') || !Number.isSafeInteger(h.round) || h.round < 1 || !Number.isSafeInteger(h.cursor) || !Number.isSafeInteger(h.processedCursor) || h.processedCursor < 0 || h.processedCursor > h.cursor || typeof h.resolved !== 'boolean' || typeof h.checkpoint !== 'string' || h.checkpoint.length > 8000 || typeof h.summary !== 'string' || h.summary.length > 8000 || !Number.isFinite(Date.parse(h.nextPollAt)) || !Number.isFinite(Date.parse(h.lastActivityAt)) || !h.post || !['queued','publishing','published','delivery_unknown'].includes(h.post.delivery) || !['question','ack'].includes(h.post.kind) || typeof h.post.key !== 'string' || typeof h.post.text !== 'string' || h.post.text.length > 2000 || (h.post.delivery === 'published' && !h.adapterId)) throw new Error('Malformed persisted human consultation; inspect private state.')
}

export function commitHumanDecision(batch, now) {
  const h = batch.human
  h.round++
  h.post = { key: `human-${batch.id}-${h.round}`, kind: h.decision.action === 'ask' ? 'question' : 'ack', text: h.decision.text, reason: '', delivery: 'queued' }
  batch.status = 'human_ack'; h.nextPollAt = now; h.readCursor = null
}
