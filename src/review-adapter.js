import { spawn } from 'node:child_process'
import path from 'node:path'

export function validateReviewPolicy(policy) {
  if (policy === null) return
  if (!policy || policy.version !== 1) throw new Error('Review policy must have version: 1.')
  const { adapter, reviewers, profile, actor, instructions, pollSeconds, expiresSeconds, maxRevisions } = policy
  if (!adapter || !Array.isArray(adapter.command) || !adapter.command.length || adapter.command.some((s) => typeof s !== 'string' || !s || s.includes('\0')) || !path.isAbsolute(adapter.command[0]) || (adapter.cwd && !path.isAbsolute(adapter.cwd))) throw new Error('Review adapter requires an absolute executable and an argv array (no shell).')
  if (!Array.isArray(reviewers) || !reviewers.length || reviewers.some((s) => typeof s !== 'string' || !s.trim()) || new Set(reviewers).size !== reviewers.length) throw new Error('Configure explicit, unique reviewer identities.')
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(profile)) throw new Error('Review profile is required.')
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 100 || /[\r\n]/.test(actor) || typeof instructions !== 'string' || !instructions.trim() || instructions.length > 8000) throw new Error('Review actor and instructions are required.')
  if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600 || !Number.isInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 2592000 || !Number.isInteger(maxRevisions) || maxRevisions < 1 || maxRevisions > 20) throw new Error('Review limits: poll 5–3600s, expiry 60s–30d, revisions 1–20.')
}

// Bounded, shell-free adapter transport. Stdout is the protocol, never a prompt
// or shell program. Do not expose stderr (which may contain credentials).
export function runAdapterCommand(command, { cwd, input = '', timeoutMs = 35000, signal, detached = process.platform !== 'win32' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Review adapter stopped.'))
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached })
    const chunks = []; let bytes = 0; let failure = null; let killTimer
    const stop = (reason) => {
      if (failure) return
      failure = new Error(reason)
      const kill = (signal) => { try { if (!detached) child.kill(signal); else process.kill(-child.pid, signal) } catch {} }
      kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1000)
    }
    const timer = setTimeout(() => stop('Review adapter timed out.'), timeoutMs)
    const onAbort = () => stop('Review adapter stopped.')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) stop('Review adapter exceeded the output limit.'); else chunks.push(chunk) })
    child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) stop('Review adapter exceeded the output limit.') })
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error('Could not start the review adapter.')) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer); clearTimeout(killTimer)
      if (failure || code !== 0) reject(failure || new Error(`Review adapter exited with code ${code}.`))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    child.stdin.end(input)
  })
}

export async function runReviewAdapter(adapter, request, { signal } = {}) {
  const output = await runAdapterCommand(adapter.command, { cwd: adapter.cwd, signal, input: JSON.stringify({ version: 1, ...request }) + '\n' })
  try { return JSON.parse(output) } catch { throw new Error('Review adapter did not return JSON.') }
}

export function validateReplyPage(page, draftId, after) {
  if (!page || !Array.isArray(page.replies) || page.replies.length > 50 || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < after) throw new Error('Invalid review reply page.')
  let previous = after
  for (const reply of page.replies) {
    if (!reply || typeof reply.id !== 'string' || !reply.id || reply.draftId !== draftId || typeof reply.messageId !== 'string' || !reply.messageId || !Number.isSafeInteger(reply.cursor) || reply.cursor <= previous || reply.cursor > page.nextCursor || (reply.text != null && (typeof reply.text !== 'string' || reply.text.length > 16000)) || (reply.transcript != null && typeof reply.transcript !== 'string')) throw new Error('Invalid or out-of-order review reply.')
    previous = reply.cursor
  }
  if (page.nextCursor !== previous) throw new Error('Review cursor must identify the last returned event; no skipped replies.')
  return page
}

export function latestReplies(events) {
  const latest = new Map()
  for (const event of events) latest.set(event.messageId, event)
  return [...latest.values()].sort((a, b) => a.cursor - b.cursor)
}

export function authorizedReply(policy, event) {
  return Boolean(event.author?.id && policy.reviewers.includes(event.author.id) && !event.author.isBot && !event.senderChat)
}

export function validateStoredReview(batch) {
  const review = batch.review
  if (!review) {
    if (['review_waiting', 'review_ready', 'reviewing'].includes(batch.status)) throw new Error('Review state is missing from its batch.')
    return
  }
  if (!Number.isFinite(Date.parse(review.expiresAt)) || !Number.isFinite(Date.parse(review.nextPollAt)) || !Array.isArray(review.revisions) || review.revisions.length < 1 || review.revisions.length > 20) throw new Error('Malformed persisted draft review.')
  for (const [index, draft] of review.revisions.entries()) {
    if (draft.number !== index + 1 || !['queued', 'publishing', 'published', 'delivery_unknown'].includes(draft.delivery) || ![draft.key, draft.text, draft.reason, draft.targetJid, draft.targetLabel].every((s) => typeof s === 'string' && s.trim()) || (draft.delivery === 'published' && (typeof draft.id !== 'string' || !draft.id)) || !Number.isSafeInteger(draft.cursor) || !Number.isSafeInteger(draft.processedCursor) || draft.processedCursor < 0 || draft.processedCursor > draft.cursor || !Array.isArray(draft.events) || draft.events.length > 2000) throw new Error('Malformed persisted draft revision.')
    let previous = 0
    for (const event of draft.events) {
      if (!Number.isSafeInteger(event.cursor) || event.cursor <= previous || event.cursor > draft.cursor || event.draftId !== draft.id || typeof event.id !== 'string' || typeof event.messageId !== 'string') throw new Error('Malformed persisted review event.')
      previous = event.cursor
    }
    if (previous !== draft.cursor) throw new Error('Persisted review cursor does not match its events.')
  }
}
