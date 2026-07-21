# WhatsApp Assistant — operating rules

Read [`docs/onboarding-and-recovery.md`](docs/onboarding-and-recovery.md)
before changing the bridge, its session, or its cache.

The normal operating mode is deliberately narrow: recent sync only, seven-day
local retention in the durable SQLite mirror, no autonomous sending, and audio transcription only on demand. A packaged installation keeps its private state outside the code package (`~/Library/Application Support/WhatsApp Assistant` on macOS); never make a formula, update, or uninstall write over that state.
Do not reset `auth/`, change history-sync settings, or ask for another QR
without first following the recovery checks in that document.

## Baileys upgrade playbook

This project is a deliberately thin wrapper over Baileys: one socket factory,
one event processor and a handful of utility functions, all normalized at the
edge into the assistant's own stable schema. Never fork Baileys, monkey-patch
its internals, or re-implement protocol behavior locally — improvements should
arrive by upgrading the dependency, not by growing a parallel layer.

The whole surface the bridge touches is pinned in
`test/baileys-contract.test.js`. To follow a Baileys release:

1. `npm view baileys version` and read the release notes/changelog.
2. `npm install baileys@<version>`.
3. `npm run check && npm test`. A contract-test failure names the exact
   touchpoint that moved; fix only that adapter code and its regression tests.
4. Restart the daemon (`wa daemon restart`) and confirm `wa status` reaches
   `open` **without a new QR**, then `wa coverage` on a known chat.
5. `wa doctor` reports the installed Baileys version for later diagnosis.

When adding a new Baileys capability to the bridge, extend the contract test
with the new import/enum in the same change, so the next upgrade also guards
it.

## Bridge-change quality gate

Before restarting the LaunchAgent after any bridge or CLI change, run `npm run
check` and `npm test`. Static syntax checks are not enough: message
normalization for every newly supported WhatsApp payload must have a regression
test. Event handlers that ingest WhatsApp updates must catch/log failures so a
bad payload cannot crash the bridge or force a re-link.

The CLI may filter by structural metadata only (chat, sender, timestamp, media
type, reply order). Do not encode semantic judgments with keywords, regexes or
language-specific heuristics: intent, urgency and follow-up decisions belong to
the AI layer consuming the retrieved messages.

For a direct contact, always resolve the current WhatsApp LID through the
bridge before reading, reacting or replying. A historical PN JID can describe
the same person but miss their current messages. Use `wa latest-incoming` for
“el último mensaje que me mandó X”; use `wa latest` only when the newest event
regardless of sender is intended.
