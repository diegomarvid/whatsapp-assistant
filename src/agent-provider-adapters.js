import path from 'node:path'
import { PROVIDERS } from './agent-providers.js'

const PROVIDER_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,160}$/

function assertProfile(profile) {
  if (!profile || !PROVIDERS[profile.provider]) throw new Error('A configured provider profile is required.')
  if (!PROVIDER_IDENTIFIER.test(profile.model || '') || String(profile.model).startsWith('-')) throw new Error('The profile needs a safe model identifier that cannot be parsed as a flag.')
  if (profile.effort && (!PROVIDER_IDENTIFIER.test(profile.effort) || String(profile.effort).startsWith('-'))) throw new Error('The profile effort must be a safe identifier that cannot be parsed as a flag.')
  if (profile.reasoningEffort && (!PROVIDER_IDENTIFIER.test(profile.reasoningEffort) || String(profile.reasoningEffort).startsWith('-'))) throw new Error('The profile reasoning effort must be a safe identifier that cannot be parsed as a flag.')
  if (profile.effort && !PROVIDERS[profile.provider].supportsEffort) throw new Error(`${PROVIDERS[profile.provider].label} does not currently expose a per-invocation effort flag.`)
  if (profile.reasoningEffort && !PROVIDERS[profile.provider].supportsReasoningEffort) throw new Error(`${PROVIDERS[profile.provider].label} does not use Codex-style reasoning effort.`)
  if (profile.effort && profile.reasoningEffort) throw new Error('A profile cannot set both Claude effort and Codex reasoning effort.')
}

// A future queue worker calls this with its own empty working directory and
// pipes the untrusted WhatsApp batch through stdin. Do not add arbitrary flags
// or shell commands to profiles: the adapter is the only command authority.
export function buildProviderInvocation(profile, { promptFile = profile?.prompt?.path, outputFile = null, executable = null } = {}) {
  assertProfile(profile)
  if (!promptFile || !path.isAbsolute(promptFile)) throw new Error('Provider invocations require an absolute prompt file.')
  if (profile.provider === 'claude') {
    return {
      command: executable || PROVIDERS.claude.binary,
      args: [
        '-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config',
        `--model=${profile.model}`,
        ...(profile.effort ? [`--effort=${profile.effort}`] : []),
        '--system-prompt-file', promptFile,
      ],
    }
  }
  if (!outputFile || !path.isAbsolute(outputFile)) throw new Error('Codex invocations require an absolute output file.')
  return {
    command: executable || PROVIDERS.codex.binary,
    args: [
      'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      `--model=${profile.model}`,
      ...(profile.reasoningEffort ? ['--config', `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`] : []),
      '--output-last-message', outputFile, '-',
    ],
  }
}

// Automations deliberately use a different invocation from `validate`: the
// provider is an agent and needs one narrowly-scoped shell capability, `wa`.
// The worker supplies a fresh directory containing a trusted `wa` shim and
// passes the private WhatsApp state directory as the only extra writable path.
// It does not parse the model's response or turn it into an action: the agent
// itself invokes the CLI when the user prompt tells it to.
export function buildAutomationProviderInvocation(profile, {
  outputFile = null,
  stateDir,
  executable = null,
} = {}) {
  assertProfile(profile)
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('Automation provider invocations require an absolute WhatsApp state directory.')
  if (profile.provider === 'claude') {
    return {
      command: executable || PROVIDERS.claude.binary,
      args: [
        '-p', '--output-format', 'json', '--no-session-persistence', '--safe-mode', '--strict-mcp-config',
        '--tools', 'Bash', '--allowedTools', 'Bash(wa *)',
        `--model=${profile.model}`,
        ...(profile.effort ? [`--effort=${profile.effort}`] : []),
      ],
    }
  }
  if (!outputFile || !path.isAbsolute(outputFile)) throw new Error('Codex automation invocations require an absolute output file.')
  return {
    command: executable || PROVIDERS.codex.binary,
    args: [
      // Codex's workspace-write sandbox blocks even the loopback request that
      // `wa` needs to make to the local bridge. The surrounding worker still
      // gives it only an ephemeral CLI state and a target-checked `wa` shim.
      'exec', '--json', '--ephemeral', '--sandbox', 'danger-full-access', '--add-dir', stateDir,
      '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      `--model=${profile.model}`,
      ...(profile.reasoningEffort ? ['--config', `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`] : []),
      '--output-last-message', outputFile, '-',
    ],
  }
}
