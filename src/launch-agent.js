import path from 'node:path'

export const launchAgentLabel = 'com.diegomarvid.whatsapp-assistant'

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlArray(values) {
  return `<array>${values.map((value) => `<string>${escapeXml(value)}</string>`).join('')}</array>`
}

export function launchAgentPlist({ nodePath, serverPath, stateRoot, logsDir, entryPath = serverPath, entryArguments = [], workingDirectory = path.dirname(serverPath) }) {
  const stdoutPath = path.join(logsDir, 'bridge.log')
  const stderrPath = path.join(logsDir, 'bridge-error.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${launchAgentLabel}</string>
  <key>ProgramArguments</key>${xmlArray([nodePath, entryPath, ...entryArguments])}
  <key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>WA_STATE_DIR</key><string>${escapeXml(stateRoot)}</string>
    <key>PATH</key><string>${escapeXml(path.dirname(nodePath))}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(stderrPath)}</string>
</dict></plist>
`
}
