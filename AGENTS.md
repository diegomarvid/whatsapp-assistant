# WhatsApp Assistant — operating rules

Read [`docs/onboarding-and-recovery.md`](docs/onboarding-and-recovery.md)
before changing the bridge, its session, or its cache.

The normal operating mode is deliberately narrow: recent sync only, seven-day
local retention in the durable SQLite mirror, no autonomous sending unless an explicitly configured rule authorizes it, and audio transcription only on demand. A packaged installation keeps its private state outside the code package (`~/Library/Application Support/WhatsApp Assistant` on macOS); never make a formula, update, or uninstall write over that state.
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
   Also confirm `presenceUnavailableAssertedAt` is set for the current
   connection: the bridge marks presence unavailable while keeping delivery
   active. `passiveModeAssertedAt: null` is intentional in this implementation.
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

For a bounded request such as “review today's conversation with X about Y”,
prefer `wa review <contact> --date today --from incoming --any <terms...> --context 4 --ids`
over combining a short history with ad-hoc search. It
requires fresh coverage, resolves the current LID, scans the retained window,
deduplicates overlapping context and keeps semantic interpretation in the AI
layer. Terms are whole words or phrases; include singular and plural variants
explicitly when both matter.

When the right CLI surface is not already obvious, start with `wa help ai`.
Use `wa help commands` for the complete situation-oriented catalog and
`wa help review` for the topic-discovery and time-expansion workflow. These
executable guides are the canonical agent entrypoint and must stay aligned
with the README, onboarding guide and integration tests.

Every review match and timeline message includes an `America/Montevideo`
`localTimestamp`. If the first pass discovers the relevant moment, expand it
without search terms using
`wa review <contact> --date YYYY-MM-DD --start HH:MM --end HH:MM --json`.
This second pass must return every message in that local
clock window so the AI can notice context that no keyword query could match.

## Autonomous conversations

Start with [`docs/automation-handoff.md`](docs/automation-handoff.md) when resuming
automation work: it maps the code, current deployment snapshot, real pilot evidence,
private operational context and remaining validation. Preserve recorded pauses;
reading or improving this repository does not reactivate a pilot.

Read [`docs/human-consultations.md`](docs/human-consultations.md) before changing
consultation behavior. It is implemented in 0.11: durable multi-turn dialogue,
acknowledgement before continuation, native executor sessions and scoped per-run
credentials. The older design/research documents explain the proposal; the runtime
guide defines the actual CLI and remaining limits. Never interpret a consultation
answer as a WhatsApp draft approval. Verify real native session behavior with the
neutral `wa automation human test` after a provider upgrade.

Read `docs/autonomous-conversations.md` before changing automation semantics or
activating a rule. New rules default to observation; retain legacy configuration
when migrating. The user may explicitly authorize a live pilot for one chat.
Use the `wa automation` tools for judge decisions and executor outcomes. Never
parse narrative model output into a send. Tests must cover server send guards,
human takeover, outbound-origin exclusion, interrupted jobs and restart repair.
Rule state is schema v4 in SQLite (imports v1/v2/v3 JSON). Stop old writers and keep a coherent private backup before upgrading. Never downgrade against the v4 storage marker.

Read `docs/draft-review.md` before changing review semantics. Review is an optional,
generic adapter contract, independent of business integrations. Keep real policies,
reviewer identities, destinations and feedback outside the public repository.
Interpret feedback in the AI layer; enforce revision, identity, cursor, exact text,
destination, pause and expiry in the engine. Never resend ambiguous publications
or deliveries, and never spend model calls merely waiting for human feedback.
