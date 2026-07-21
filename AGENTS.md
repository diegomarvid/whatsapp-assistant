# WhatsApp Assistant — operating rules

Read [`docs/onboarding-and-recovery.md`](docs/onboarding-and-recovery.md)
before changing the bridge, its session, or its cache.

The normal operating mode is deliberately narrow: recent sync only, 30-day
local retention, no autonomous sending, and audio transcription only on demand.
Do not reset `auth/`, change history-sync settings, or ask for another QR
without first following the recovery checks in that document.

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
