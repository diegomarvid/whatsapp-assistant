#!/usr/bin/env node
import fs from 'node:fs/promises'

// Engine-owned PreToolUse hook. It never grants Bash/file permissions. A
// native question is answered only with the decision prepared for this exact
// pending tool, after the engine has published the human acknowledgement.
try {
  const chunks = []; let bytes = 0
  for await (const c of process.stdin) { bytes += c.length; if (bytes > 65536) throw new Error('Input too large'); chunks.push(c) }
  const request = JSON.parse(Buffer.concat(chunks).toString())
  if (request.tool_name !== 'AskUserQuestion') throw new Error('Unexpected tool')
  const answer = JSON.parse(await fs.readFile(process.argv[3], 'utf8'))
  if (answer?.id === request.tool_use_id && answer.answers && request.tool_input.questions.every((q) => typeof answer.answers[q.question] === 'string')) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...request.tool_input, answers: answer.answers } } }))
  } else {
    await fs.writeFile(process.argv[2], JSON.stringify(request), { mode: 0o600 })
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }))
  }
} catch {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Human consultation hook unavailable; use wa automation human ask and stop safely.' } }))
}
