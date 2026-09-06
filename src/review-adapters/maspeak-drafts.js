#!/usr/bin/env node
// Optional bridge to the private Maspeak CLI. Core review code has no
// dependency on this service, its credentials, or a particular Telegram bot.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAdapterCommand } from '../review-adapter.js'

export async function maspeakDrafts(request, config, run = runAdapterCommand) {
  const invoke = async (args) => {
    const result = JSON.parse(await run([...config.command, ...args, '--json'], { cwd: config.cwd, detached: false }))
    if (!result.ok) throw new Error('Maspeak drafts service rejected the request.')
    return result.data
  }
  if (request.version === 2) {
    if (request.op === 'status') { const status = await invoke(['status']); return { version: 2, capabilities: { dialogues: status.dialogue_protocol === 2, idempotentInspection: status.dialogue_protocol === 2 }, status } }
    if (['open', 'post'].includes(request.op)) {
      const p = request.post
      const result = await invoke([...(request.op === 'open' ? ['dialogue-open'] : ['dialogue-post', request.dialogueId]), '--key', p.key, '--target', p.target, '--actor', p.actor, '--automation', p.automation, '--kind', p.kind, '--text', p.text, ...(p.reason ? ['--reason', p.reason] : [])])
      return { id: result.id, messageId: result.message_id, status: result.state === 'sent' ? 'published' : 'delivery_unknown' }
    }
    if (request.op === 'inspect') {
      const result = await invoke(['dialogue-inspect', '--key', request.key])
      return result ? { id: result.id, key: result.key, messageId: result.message_id, status: result.state === 'sent' ? 'published' : 'delivery_unknown' } : { status: 'not_found' }
    }
    if (request.op === 'events') request = { ...request, op: 'replies', draftId: request.dialogueId, dialogue: true }
    else throw new Error('Unsupported dialogue operation.')
  }
  if (![1, 2].includes(request.version)) throw new Error('Unsupported protocol version.')
  if (request.op === 'status') return { status: await invoke(['status']) }
  if (request.op === 'publish') {
    const { draft } = request
    const result = await invoke([...(draft.parentId ? ['revise', draft.parentId] : ['send']), '--key', draft.key, '--target', draft.target.label, '--actor', draft.context.actor, '--automation', draft.context.automation, '--reason', draft.context.reason, '--revision', String(draft.revision), '--text', draft.text])
    return { id: result.id, messageId: result.message_id, status: result.state === 'sent' ? 'published' : 'delivery_unknown' }
  }
  if (request.op === 'replies') {
    const result = await invoke([request.dialogue ? 'dialogue-events' : 'replies', request.draftId, '--after', String(request.after), '--wait', '0'])
    const replies = []
    for (const r of result.replies) {
      const reply = { id: r.reply_id, cursor: r.cursor, draftId: r.draft_id, messageId: String(r.message_id), replyToMessageId: String(r.reply_to_message_id || ''), author: r.from ? { id: `telegram:${r.from.id}`, label: [r.from.first_name, r.from.last_name].filter(Boolean).join(' '), isBot: r.from.is_bot === true } : null, senderChat: r.sender_chat || null, date: r.date, text: r.text, edited: r.edited === true, audio: r.audio ? { mimeType: r.audio.mime_type, duration: r.audio.duration } : null }
      if (r.audio && config.transcribeCommand) {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-review-audio-'))
        try {
          const filename = path.join(directory, 'reply.ogg')
          await invoke(['audio', r.reply_id, '--out', filename])
          // Transcriber contract: audio path appended to argv, JSON text on
          // stdout. The adapter always removes its private audio afterward.
          const transcription = JSON.parse(await run([...config.transcribeCommand, filename], { cwd: config.cwd, detached: false }))
          if (typeof transcription.text !== 'string' || !transcription.text.trim()) throw new Error('Transcription unavailable.')
          reply.transcript = transcription.text
        } finally { await fs.rm(directory, { recursive: true, force: true }) }
      }
      replies.push(reply)
    }
    return { replies, nextCursor: result.next_cursor }
  }
  throw new Error('Unsupported review operation.')
}

async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
  for (const command of [config.command, ...(config.transcribeCommand ? [config.transcribeCommand] : [])]) {
    if (!Array.isArray(command) || !command.length || !path.isAbsolute(command[0]) || command.some((s) => typeof s !== 'string' || !s || s.includes('\0'))) throw new Error('Use absolute executables with argument arrays in the adapter config.')
  }
  const chunks = []; let bytes = 0
  for await (const chunk of process.stdin) { chunks.push(chunk); bytes += chunk.length; if (bytes > 65536) throw new Error('Input limit exceeded.') }
  console.log(JSON.stringify(await maspeakDrafts(JSON.parse(Buffer.concat(chunks).toString('utf8')), config)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Maspeak draft adapter failed. Inspect its configuration and service status.'); process.exitCode = 1 })
