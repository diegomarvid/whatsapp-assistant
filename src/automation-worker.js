import { workspaceCheckpoint } from './workspace-checkpoint.js'
import { journal } from './automation-store.js'
import { runPromptAutomation } from './agent-provider-runner.js'

// Message ingestion persists events; this worker only claims due jobs. It does
// not inspect message text or infer intent. Decisions/results use scoped tools.
export class AutomationWorker {
  constructor({ rules, profiles, capabilities, stateDir, connected, coverage, resolveJid, reviews = null, human = null, messages = () => [], run = runPromptAutomation, logger = console, maxConcurrent = 3 }) {
    Object.assign(this, { rules, profiles, capabilities, stateDir, connected, coverage, resolveJid, reviews, human, messages, run, logger, maxConcurrent })
    this.jobs = new Set()
    this.controllers = new Set()
    this.dispatching = false
    this.stopping = false
    this.lastReconcileAt = 0
  }

  async tick() {
    if (this.dispatching || this.stopping) return
    this.dispatching = true
    try {
      await this.cancelInvalidated()
      this.reviews?.tick()
      this.human?.tick()
      if (this.connected() && Date.now() - this.lastReconcileAt >= 60000) {
        await this.rules.reconcile(this.messages(), { resolveSourceJid: this.resolveJid })
        this.lastReconcileAt = Date.now()
      }
      const profiles = await this.profiles.list()
      const workspaces = Object.fromEntries(profiles.map((profile) => [profile.name, profile.workspace?.path || null]))
      while (this.jobs.size < this.maxConcurrent) {
        const batch = await this.rules.claimDue({ workspaces, maxConcurrent: this.maxConcurrent, connected: this.connected() })
        if (!batch) break
        const job = this.execute(batch).catch((error) => this.logger.error({ err: error, batchId: batch.id }, 'Automation worker failed'))
        this.jobs.add(job)
        job.finally(() => this.jobs.delete(job))
      }
    } finally {
      this.dispatching = false
    }
  }

  async cancelInvalidated() {
    if (!this.controllers.size) return
    const { batches } = await this.rules.load()
    for (const controller of this.controllers) {
      const batch = batches.find((item) => item.id === controller.batchId)
      // An ordinary follow-up must not interrupt a deployment mid-command.
      // Always stop on explicit control; plain conversation/judge runs can
      // restart on fresh messages without replaying code side effects.
      if (batch?.invalidated && (batch.invalidationKind !== 'new_messages' || !controller.workspace)) controller.abort()
    }
  }

  stop() { this.stopping = true; this.reviews?.stop(); this.human?.stop(); for (const controller of this.controllers) controller.abort() }

  async drain() { await Promise.all([...this.jobs, this.reviews?.job, this.human?.job].filter(Boolean)) }

  async execute(batch) {
    let token = null
    let workspace = false
    const controller = new AbortController()
    controller.batchId = batch.id
    controller.workspace = Boolean(batch.workspaceLock)
    this.controllers.add(controller)
    const stage = batch.status === 'clarifying' ? 'clarify' : batch.status === 'judging' ? 'judge' : batch.status === 'reviewing' ? 'review' : 'execute'
    try {
      const rule = await this.rules.getById(batch.ruleId)
      const source = await this.resolveJid(rule.sourceOriginalJid)
      if (stage !== 'clarify' && (!this.connected() || !(await this.coverage(source)).fresh)) {
        await this.rules.defer(batch.id)
        return
      }
      if (stage === 'execute' && batch.human?.resolved) {
        try { if (!await this.human.beforeResume(batch)) return }
        catch (error) {
          await this.rules.mutate(async (state) => { const b = state.batches.find((b) => b.id === batch.id); if (b?.human) b.human.lastError = error.message })
          await this.rules.defer(batch.id); return
        }
      }
      const destination = await this.resolveJid(rule.destinationOriginalJid)
      const profile = await this.profiles.get(stage === 'judge' ? rule.judgeProfile : stage === 'review' ? rule.review.profile : stage === 'clarify' ? rule.humanConsultation.profile : rule.profile)
      if (!profile) throw new Error('The configured provider profile is missing.')
      if ((profile.workspace?.path || null) !== (batch.workspaceLock || null) && stage === 'execute') throw new Error('Workspace changed after this job was claimed; inspect configuration before retrying.')
      if (['review', 'clarify'].includes(stage) && profile.workspace) throw new Error('Review profile must not have a workspace.')
      const readOnly = stage !== 'execute' || rule.mode === 'observe' || batch.observe
      workspace = !readOnly && Boolean(profile.workspace?.path)
      controller.workspace = workspace
      token = this.capabilities.issue({
        readJids: [rule.sourceJid, rule.sourceOriginalJid, batch.sourceJid, source],
        sendJids: readOnly || rule.review ? [] : [rule.destinationJid, rule.destinationOriginalJid, destination],
        ttlMs: profile.timeoutMs == null || profile.timeoutMs === 0 ? 0 : profile.timeoutMs + 30000,
        batchId: batch.id, runId: batch.runId, stage,
      })
      const context = await this.rules.context(rule.id)
      await this.rules.assertRun(batch.id, batch.runId)
      if (rule.humanConsultation && stage === 'execute' && !readOnly) {
        const snapshot = workspace ? await workspaceCheckpoint(profile.workspace.path) : null
        if (batch.human?.resolved && batch.workspaceCheckpoint && snapshot?.digest !== batch.workspaceCheckpoint.digest) {
          await this.human.ask(batch.id, batch.runId, { question: 'El repositorio cambió mientras esperaba. ¿Cómo querés que tenga en cuenta esos cambios antes de seguir?', reason: 'Necesito reconciliar el trabajo guardado con el estado actual.', checkpoint: batch.human.summary || batch.human.checkpoint }, { preserveNativeQuestion: true })
          await this.rules.mutate(async (state) => { state.batches.find((b) => b.id === batch.id).workspaceCheckpoint = snapshot })
          await this.rules.finishRun(batch.id, { ok: true, output: 'Workspace changed; awaiting human clarification.' }, { stage, workspace })
          return
        }
        await this.rules.mutate(async (state) => {
          const current = state.batches.find((b) => b.id === batch.id)
          current.workspaceCheckpoint = snapshot
          if (!current.sourceCheckpointed) {
            for (const message of this.messages().filter((m) => batch.messageIds.includes(m.id) && [source, batch.sourceJid].includes(m.jid))) journal(state, batch.id, `initial-${batch.id}-${message.id}`, 'source', message)
            current.sourceCheckpointed = true
          }
        })
      }
      const result = await this.run(profile, { rule, batch, stage, context, stateDir: this.stateDir, capabilityToken: token, signal: controller.signal })
      if (result.ok && result.nativeQuestion) {
        const question = result.nativeQuestion.input.questions.map((q) => q.question + (q.options?.length ? '\n' + q.options.map((o) => '• ' + o.label + (o.description ? ': ' + o.description : '')).join('\n') : '')).join('\n\n')
        await this.human.ask(batch.id, batch.runId, { question: question.length <= 2000 ? question : question.slice(0, 1850) + '\n\nHay más detalles en la consulta; los podemos aclarar en el próximo intercambio.', reason: 'La IA necesita información para continuar con el trabajo.', checkpoint: batch.human?.summary || batch.human?.checkpoint || 'Sesión nativa suspendida antes de ejecutar AskUserQuestion. Releer el estado actual y el historial de herramientas antes de continuar; no repetir efectos ya realizados.' })
      }
      if (result.ok && workspace && rule.humanConsultation) {
        const snapshot = await workspaceCheckpoint(profile.workspace.path)
        await this.rules.mutate(async (state) => { state.batches.find((b) => b.id === batch.id).workspaceCheckpoint = snapshot })
      }
      const finished = stage === 'clarify' ? await this.human.finish(batch.id, result) : await this.rules.finishRun(batch.id, result, { stage, workspace })
      this.logger.info({ automationRule: rule.name, batchId: batch.id, stage, status: finished?.status, sendCount: finished?.sendCount || 0 }, 'Automation stage finished')
    } catch (error) {
      if (stage === 'clarify') await this.human.finish(batch.id, { ok: false, error: error.message })
      else await this.rules.finishRun(batch.id, { ok: false, error: error.message }, { stage, workspace })
      this.logger.error({ err: error, batchId: batch.id }, 'Automation could not complete')
    } finally {
      this.controllers.delete(controller)
      if (token) this.capabilities.revoke(token)
    }
  }
}
