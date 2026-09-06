import { runPromptAutomation } from './agent-provider-runner.js'

// Message ingestion persists events; this worker only claims due jobs. It does
// not inspect message text or infer intent. Decisions/results use scoped tools.
export class AutomationWorker {
  constructor({ rules, profiles, capabilities, stateDir, connected, coverage, resolveJid, messages = () => [], run = runPromptAutomation, logger = console, maxConcurrent = 3 }) {
    Object.assign(this, { rules, profiles, capabilities, stateDir, connected, coverage, resolveJid, messages, run, logger, maxConcurrent })
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
      if (!this.connected()) return
      if (Date.now() - this.lastReconcileAt >= 60000) {
        await this.rules.reconcile(this.messages(), { resolveSourceJid: this.resolveJid })
        this.lastReconcileAt = Date.now()
      }
      const profiles = await this.profiles.list()
      const workspaces = Object.fromEntries(profiles.map((profile) => [profile.name, profile.workspace?.path || null]))
      while (this.jobs.size < this.maxConcurrent) {
        const batch = await this.rules.claimDue({ workspaces, maxConcurrent: this.maxConcurrent })
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

  stop() { this.stopping = true; for (const controller of this.controllers) controller.abort() }

  async drain() { await Promise.all([...this.jobs]) }

  async execute(batch) {
    let token = null
    let workspace = false
    const controller = new AbortController()
    controller.batchId = batch.id
    controller.workspace = Boolean(batch.workspaceLock)
    this.controllers.add(controller)
    const stage = batch.status === 'judging' ? 'judge' : 'execute'
    try {
      const rule = await this.rules.getById(batch.ruleId)
      const source = await this.resolveJid(rule.sourceOriginalJid)
      if (!this.connected() || !(await this.coverage(source)).fresh) {
        await this.rules.defer(batch.id)
        return
      }
      const destination = await this.resolveJid(rule.destinationOriginalJid)
      const profile = await this.profiles.get(stage === 'judge' ? rule.judgeProfile : rule.profile)
      if (!profile) throw new Error('The configured provider profile is missing.')
      if ((profile.workspace?.path || null) !== (batch.workspaceLock || null) && stage !== 'judge') throw new Error('Workspace changed after this job was claimed; inspect configuration before retrying.')
      const readOnly = stage === 'judge' || rule.mode === 'observe' || batch.observe
      workspace = !readOnly && Boolean(profile.workspace?.path)
      controller.workspace = workspace
      token = this.capabilities.issue({
        readJids: [rule.sourceJid, rule.sourceOriginalJid, batch.sourceJid, source],
        sendJids: readOnly ? [] : [rule.destinationJid, rule.destinationOriginalJid, destination],
        ttlMs: (profile.timeoutMs || 60000) + 30000,
        batchId: batch.id, runId: batch.runId, stage,
      })
      const context = await this.rules.context(rule.id)
      await this.rules.assertRun(batch.id, batch.runId)
      const result = await this.run(profile, { rule, batch, stage, context, stateDir: this.stateDir, capabilityToken: token, signal: controller.signal })
      const finished = await this.rules.finishRun(batch.id, result, { stage, workspace })
      this.logger.info({ automationRule: rule.name, batchId: batch.id, stage, status: finished?.status, sendCount: finished?.sendCount || 0 }, 'Automation stage finished')
    } catch (error) {
      await this.rules.finishRun(batch.id, { ok: false, error: error.message }, { stage, workspace })
      this.logger.error({ err: error, batchId: batch.id }, 'Automation could not complete')
    } finally {
      this.controllers.delete(controller)
      if (token) this.capabilities.revoke(token)
    }
  }
}
