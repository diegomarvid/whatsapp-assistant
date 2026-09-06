#!/usr/bin/env node
import readline from 'node:readline'

// Minimal stdio MCP permission handler makes AskUserQuestion available in
// Claude's headless mode. The PreToolUse hook handles questions before this
// fallback. Unconfigured permissions are denied, never silently broadened.
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (Buffer.byteLength(line) > 65536) process.exit(1)
  let request; try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wa-control', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: 'permission', description: 'Headless permission boundary: deny unconfigured actions.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] } }] }
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'This action is outside the configured headless permissions. Use wa automation human ask to explain the blocker and save a checkpoint. A human clarification cannot change tool permissions.' }) }] }
  else if (request.method === 'ping') result = {}
  else { console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })); continue }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
}
