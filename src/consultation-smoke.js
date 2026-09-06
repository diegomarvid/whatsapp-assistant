import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { PromptAutomationRules } from './prompt-automation-rules.js'
import { AutomationCapabilities } from './automation-capabilities.js'
import { AutomationHuman } from './automation-human.js'
import { AutomationWorker } from './automation-worker.js'
import { runPromptAutomation } from './agent-provider-runner.js'
import { inspectPromptFile } from './agent-providers.js'
import { withHumanDefaults } from './human-policy.js'

// A real CLI/session/worker round trip with a fixture-only loopback bridge.
// There is no WhatsApp socket, workspace or send endpoint. With a policy file,
// only the consultation messages reach the configured human channel.
export async function consultationSmoke({ profile, stateDir, policy = null, log = console.log }) {
  if (!path.isAbsolute(stateDir)) throw new Error('Use an absolute private test state directory.')
  await fs.mkdir(path.join(stateDir, 'data'), { recursive: true, mode: 0o700 })
  const filename = path.join(stateDir, 'data', 'prompt-automations.json')
  const rules = new PromptAutomationRules(filename)
  const existing = await rules.list()
  if (existing.some((r) => r.name !== 'consultation-smoke')) throw new Error('The test directory contains other automations. Use a dedicated directory.')
  const taskPath = path.join(stateDir, 'executor.md'); const interpreterPath = path.join(stateDir, 'interpreter.md')
  await fs.writeFile(taskPath, `This is a harmless end-to-end test of a human consultation. Do not send WhatsApp messages. Do not write files or perform business work. We need a sample color (blue or green) and a shade (light or dark). If this is the first run, ask ONLY for the color, in Spanish. ${profile.provider === 'claude' ? 'Use native AskUserQuestion as a single tool call.' : 'Use wa automation human ask and save a checkpoint saying no work has been done and color and shade are pending.'} On continuation, read wa automation human context. If both color and shade are known, call wa automation result no_reply with a summary naming the chosen color and shade. Otherwise ask for the missing information. Do not ask again for facts already answered.\n`, { mode: 0o600 })
  await fs.writeFile(interpreterPath, 'This is a harmless consultation test. Determine the sample color and shade from the human replies. If the shade is missing, ask in Spanish whether it should be light or dark. Continue only once both are clear; the acknowledgement must name both. For native questions, answer the original color question from the human evidence. No WhatsApp drafts or sends.\n', { mode: 0o600 })
  const executor = { ...profile, name: 'smoke-executor', workspace: null, timeoutMs: 180000, prompt: await inspectPromptFile(taskPath) }
  const interpreter = { ...executor, name: 'smoke-interpreter', prompt: await inspectPromptFile(interpreterPath) }
  const effectivePolicy = withHumanDefaults({ ...(policy || { version: 1, adapter: { command: ['/simulation/only'] }, actor: 'Prueba local', responders: ['simulation:human'], instructions: 'Determine a color and shade.' }), profile: interpreter.name, replyDebounceSeconds: policy?.replyDebounceSeconds ?? 0 })
  const rule = existing[0] || await rules.add({ name: 'consultation-smoke', source: 'Ejemplo de prueba', sourceTarget: 'sample@lid', sourceJid: 'sample@lid', destination: 'Ejemplo de prueba (sin WhatsApp)', destinationTarget: 'sample@lid', destinationJid: 'sample@lid', profile: executor.name, humanConsultation: effectivePolicy, trigger: 'manual', debounceSeconds: 0 })
  if (rule.profile !== executor.name || rule.humanConsultation.profile !== interpreter.name || JSON.stringify(rule.humanConsultation) !== JSON.stringify(effectivePolicy)) throw new Error('Use the same test policy to resume this directory.')
  await rules.recoverInterrupted()
  let batch = (await rules.batchesFor(rule.id)).at(-1)
  if (!batch) batch = await rules.trigger(rule.name, 'smoke-v1', 'Prueba del circuito de consultas. No hay mensajes de clientes ni envío a WhatsApp.', 'sample@lid')
  const caps = new AutomationCapabilities()
  const events = []; const posted = new Map(); let sequence = 0
  const human = new AutomationHuman(rules, policy ? {} : { adapter: async (_a, request) => {
    if (['open', 'post'].includes(request.op)) {
      if (!posted.has(request.post.key)) {
        const result = { id: 'simulation-dialogue', key: request.post.key, messageId: ++sequence, status: 'published' }; posted.set(request.post.key, result)
        if (request.post.kind === 'question') {
          const cursor = events.length + 1
          events.push({ id: String(cursor), cursor, draftId: result.id, messageId: String(1000 + cursor), author: { id: 'simulation:human', isBot: false }, text: cursor === 1 ? 'Azul.' : 'Oscuro.' })
        }
        log(JSON.stringify({ event: 'simulated_post', ...request.post }))
      }
      return posted.get(request.post.key)
    }
    if (request.op === 'inspect') return posted.get(request.key) || { status: 'not_found' }
    if (request.op === 'events') { const replies = events.filter((e) => e.cursor > request.after).slice(0, 50); return { replies, nextCursor: replies.at(-1)?.cursor || request.after } }
    throw new Error('Unsupported simulation operation.')
  } })
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    const url = new URL(request.url, 'http://127.0.0.1')
    const auth = caps.authorization((request.headers.authorization || '').replace(/^Bearer /, ''), 'no-master-credential')
    if (!auth || auth.kind !== 'automation') return send(401, { error: 'unauthorized' })
    try {
      const chunks = []; let bytes = 0
      for await (const part of request) { bytes += part.length; if (bytes > 32768) throw new Error('Request too large'); chunks.push(part) }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      if (request.method === 'POST') {
        if (url.pathname === '/automation/human/ask' && auth.stage === 'execute') return send(200, await human.ask(auth.batchId, auth.runId, body))
        if (url.pathname === '/automation/human/decision' && auth.stage === 'clarify') return send(200, await human.decide(auth.batchId, auth.runId, body))
        if (url.pathname === '/automation/result' && auth.stage === 'execute') return send(200, await rules.report(auth.batchId, auth.runId, body.outcome, body.summary, body.resumeAfter))
        return send(403, { error: 'This test has no external write endpoints.' })
      }
      if (url.pathname === '/automation/human') return send(200, await human.context(auth.batchId, auth.runId, url.searchParams.has('after') ? Number(url.searchParams.get('after')) : null, Number(url.searchParams.get('sourceAfter') || 0)))
      if (url.pathname === '/automation/context') return send(200, await rules.context(rule.id))
      if (url.pathname === '/health') return send(200, { connection: 'open', fixtureOnly: true })
      if (url.pathname === '/coverage') return send(200, { jid: 'sample@lid', fresh: true, fixtureOnly: true })
      if (url.pathname === '/resolve') return send(200, { jid: 'sample@lid', requestedJid: 'sample@lid' })
      if (url.pathname === '/messages') return send(200, { jid: 'sample@lid', messages: [] })
      return send(404, { error: 'No fixture for this read.' })
    } catch (error) { return send(422, { error: error.message, message: error.message }) }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const worker = new AutomationWorker({ rules, profiles: { list: async () => [executor, interpreter], get: async (name) => [executor, interpreter].find((p) => p.name === name) }, capabilities: caps, stateDir,
    human, connected: () => true, coverage: async () => ({ fresh: true }), resolveJid: async (jid) => jid,
    logger: { info: (v) => log(JSON.stringify(v)), error: (v) => log(JSON.stringify({ ...v, error: v.err?.message })) },
    run: (profile, input) => runPromptAutomation(profile, { ...input, env: { ...process.env, WA_BRIDGE_PORT: String(server.address().port) } }) })
  let stopped = false
  const stop = () => { stopped = true; worker.stop() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  log(JSON.stringify({ event: 'started', provider: profile.provider, model: profile.model, stateDir, workId: batch.id, channel: policy ? 'configured-adapter' : 'simulation', whatsapp: false }))
  try {
    let previous = ''
    while (!stopped) {
      await worker.tick()
      batch = (await rules.batchesFor(rule.id)).at(-1)
      if (previous !== batch.status) { log(JSON.stringify({ event: 'state', status: batch.status, detail: batch.human?.lastError || batch.lastError })); previous = batch.status }
      if (['completed', 'canceled', 'failed', 'uncertain', 'human_frozen'].includes(batch.status)) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    log(JSON.stringify({ event: 'result', status: batch.status, summary: batch.summary, rounds: batch.human?.round, session: batch.providerSessions?.execute, whatsappSends: (await rules.load()).outbound.length }))
    return { status: batch.status, stateDir, workId: batch.id }
  } finally {
    worker.stop(); await worker.drain(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    await new Promise((resolve) => server.close(resolve))
  }
}
