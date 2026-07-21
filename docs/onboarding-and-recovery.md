# Onboarding, cache and recovery

This is the operational source of truth for the local WhatsApp assistant.
Its goal is to make the normal path reliable without repeatedly asking the user
to scan a QR code.

## Normal operating mode

- Baileys can run as a local macOS LaunchAgent or Linux systemd user service.
- It listens only on `127.0.0.1:3847`; it does not expose an internet-facing
  API. Sending is available only through the local CLI after an explicit user
  instruction.
- The linked-device session lives in `auth/`. As long as that directory stays
  intact, a restart or Mac reboot reconnects automatically and **does not need
  another QR**.
- WhatsApp is requested in **recent sync** mode (`syncFullHistory: false`).
  The provider chooses the precise size of that initial recent window.
- The durable local SQLite mirror keeps only the newest seven days, capped at
  10,000 messages. Older data is deliberately pruned. This is not a complete
  WhatsApp archive.
- A recoverable raw-message envelope, plus audio/image/document envelopes where
  applicable, is retained privately for that same seven-day window. This lets
  Baileys retry or resolve an incomplete recent message without widening the
  local retention policy. The envelopes are never uploaded.
- The bridge records a seven-day technical event audit (event kind, chat/message
  identifiers, timestamps and payload type; never message text) so a missing
  message can be diagnosed as an upstream event, placeholder, update, or local
  ingestion issue.
- WhatsApp may deliver new events under a contact LID rather than its phone
  JID. The local CLI resolves a phone JID to the current LID before asking for
  coverage, messages, replies or reactions. Do not bypass the CLI by manually
  reusing a JID copied from old cache output.

All sensitive runtime state is under `data/` or `auth/`, is private to the
local user, and is excluded from Git.

## One-time onboarding

1. On macOS, install and start through Homebrew:

   ```bash
   brew tap diegomarvid/tap
   brew install whatsapp-assistant
   wa setup
   ```

   `wa setup` creates a user LaunchAgent, waits for the bridge to initialize
   and opens `link-qr.png` only when a new link is required. If initialization
   takes longer, use `wa qr` to open a pending QR and `wa doctor` for a
   secrets-free diagnosis. The packaged installation keeps all private state at
   `~/Library/Application Support/WhatsApp Assistant/`, outside Homebrew.

   If migrating from a prior checkout, run this before setup to preserve the
   existing linked-device session:

   ```bash
   wa migrate-state ~/Documents/whatsapp-assistant
   wa setup
   ```

   On Linux/VPS, use the final non-root account that will own the WhatsApp
   session. It needs Node.js 22+ and systemd; do not run `wa` with sudo. If
   Node is absent or global npm would require elevated permissions, install it
   for this user with nvm, then use:

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   . "$HOME/.nvm/nvm.sh" && nvm install 22
   node --version # v22 or newer
   npm install -g https://github.com/diegomarvid/whatsapp-assistant/archive/refs/tags/v0.8.2.tar.gz
   wa setup
   sudo loginctl enable-linger "$USER"
   ```

   `wa setup` installs `whatsapp-assistant.service` as a systemd user service,
   writes private runtime state to `~/.local/state/whatsapp-assistant/` by
   default and prints the temporary QR in the SSH terminal. `enable-linger` is
   needed once on a VPS so the user service survives logout and reboot. `wa
   doctor` names this exact missing step rather than reporting the installation
   ready prematurely.

2. For development from a checkout, install dependencies and the local CLI:

   ```bash
   npm install
   npm link
   ```

3. The development checkout can load or start a LaunchAgent manually on macOS:

   ```bash
   launchctl bootstrap gui/$(id -u) \
     "$HOME/Library/LaunchAgents/com.example.whatsapp-assistant.plist"
   ```

4. Scan the QR shown by `wa qr` (or at `data/link-qr.png` in a development
   checkout) only if `auth/` has not been
   created yet, or WhatsApp explicitly logged the device out.
5. Wait for `wa status` to report `"connection": "open"`. The cache count can
   rise for a little while after that as the recent sync arrives.

After this first link, do not scan again just because a query looks old. First
check the cache window and service health below.

## What the mirror can know

This same guide is available to an agent at runtime with `wa help data`. It is
an availability boundary, not an interpretation rule.

### Facts that can come from before installation

Only when WhatsApp includes them in its recent sync and they remain inside the
seven-day local window, the mirror can show the message text, timestamp,
sender, quote, type and available attachment. It may show the current edited or
ephemeral representation delivered in that sync. A reaction or receipt from a
past message is usable only if WhatsApp included that factual field in the
synced message; it is never guaranteed merely because the message itself is
present.

### Facts that cannot be reconstructed retroactively

The mirror cannot fill in older history, a message's pre-edit text, prior
reaction/receipt timelines, poll votes whose creation key and encrypted update
were not observed, or past group changes, call events and deletion sequences.
It intentionally does not turn on full-history sync to attempt this.

### Facts observed while the bridge is active

While the linked bridge is connected and healthy, it records incoming messages
and the WhatsApp updates it receives for edits, deletions, delivery/read/played
receipts, reactions, eligible poll votes, missed-call message events and group
metadata or membership changes. Those are factual WhatsApp reports, not proof
of a person's intent or attention. In particular, a missing read receipt means
only that no read receipt was reported; it does not mean the person did not
read the message. Individual group receipts are available only for messages
sent by this account. View-once content is never exposed or downloaded.

## Everyday CLI

```bash
wa status
wa aliases
wa alias add contacto +598XXXXXXXX "Nombre del contacto"
wa find "Nombre del contacto"
wa latest contacto
wa latest-incoming contacto
wa history contacto 20
wa delivery contacto <message-id>
wa receipts grupo@g.us <message-id>
wa reactions contacto <message-id>
wa polls contacto
wa poll contacto <message-id>
wa calls contacto
wa group-events grupo@g.us
wa search contacto "presupuesto"
wa transcribe contacto latest
wa images contacto
wa image contacto <message-id>
wa send contacto "Mensaje explícitamente pedido por el usuario"
```

Aliases live in `data/aliases.json`, not in Git. When the user supplies a stable
name/number mapping, save it with `wa alias add` so later requests like
“buscá el último mensaje de un contacto” stay one command.

`wa transcribe <alias> latest` does this locally:

1. Finds the most recent audio in that chat.
2. Uses Baileys to download only that selected audio.
3. Runs the private Python Whisper runtime with a locally available model.
4. Prints the transcript. It does not send anything to the contact.

Transcription is optional and is not installed by `npm install`. On the first
`wa transcribe` request the CLI installs the matching library into the private
`transcribe-venv/` under the WhatsApp Assistant state directory. Apple Silicon
uses `mlx-whisper`; Linux and Intel Macs use `faster-whisper`. `wa transcribe
setup` remains available to do that proactively and never downloads a Whisper model: use `wa transcribe doctor` to inspect
the compatible Hugging Face cache, then explicitly run `wa transcribe pull` if
the user approves a download. The bridge and all non-audio commands work
without it.

`wa images <alias>` lists cached images and whether the encrypted media envelope
is available. `wa image <alias> <message-id>` downloads only that selected image
to the private `data/images/` directory. Images that arrived before image capture
was enabled cannot be recovered from the existing cache; ask the sender to
forward them again rather than re-linking just for one image.

`wa send <alias> "texto"` sends a text message. Use it only when the user has
directly asked to send that exact message; never infer a send from a search,
summary or drafted reply.

`wa latest` is the newest event in the chat. Use `wa latest-incoming` when the
request is “el último mensaje que me mandó X”: it excludes the user's own later
messages. Both commands resolve the current LID first and then require fresh
coverage. Group JIDs (`…@g.us`) can be passed directly to `coverage` and other
read commands; only direct contacts use LID resolution.

## Recovery checklist — before ever asking for a QR

1. Check the daemon and cache:

   ```bash
   wa status
   wa daemon status
   ```

2. If it is not `open`, restart the existing service only:

   ```bash
   wa daemon restart
   ```

   Wait a few seconds and run `wa status` again. This preserves the linked
   session and normally reconnects without interaction.

3. If a conversation seems to be missing, inspect `wa status` and `wa coverage
   contacto`, then `wa latest-incoming contacto`. The observer automatically
   reconnects with the existing linked session and the CLI resolves the current
   LID before reading it. Messages older than seven days are intentionally
absent. The assistant is for recent operational context, not an archive.

## Receipts and reactions are factual, not inferred

For an outgoing direct message, `wa delivery contacto <message-id>` returns the
aggregate WhatsApp delivery/read/played state and the timestamp reported in the
corresponding protocol update.

For a message sent by this account to a group, use `wa receipts grupo@g.us
<message-id>` to see the per-participant receipts that WhatsApp actually
reported, or `wa unread-by` to list current participants that have no reported
read receipt. That latter list
must never be described as “people who did not read it”: privacy settings,
connectivity and observer uptime can all suppress a receipt. `wa reactions`
returns only the reaction state currently reported by WhatsApp; an emptied
reaction is removed when WhatsApp sends that update.

## Content lifecycle and group facts

The bridge keeps the factual lifecycle of recent messages: edited content is
shown as edited, ephemeral content is labelled, and a WhatsApp revocation marks
the local message as deleted and removes cached media for it. It deliberately
does not unwrap, expose or download *view once* content.

`wa polls` and `wa poll` expose votes only when the bridge has the local poll
key and observed the encrypted vote update while connected. `wa calls` lists
missed-call message events. `wa group-events` contains membership and metadata
changes received while the observer was running. All three follow the same
seven-day retention policy and are not an archive.

4. If `wa transcribe` says an old audio is unavailable, it may predate the
   current recent-sync window or the audio-envelope capture. Do **not** reset
   the session automatically. Explain that limitation and ask whether the user
   wants a deliberate re-link/re-sync.

## QR is the last resort

Only request a QR when one of these is true:

- WhatsApp marked the linked device as logged out.
- `auth/` was genuinely lost or corrupted and a service restart did not help.
- The user explicitly asks to deliberately re-link and accepts a new recent
  sync.

Before re-linking, back up `auth/` inside ignored `data/`, never delete it
blindly. Preserve the current cache and aliases. Then show one fresh QR and
wait for the user to scan it; do not cycle QRs or alter sync settings again
while waiting.

## Explicit guardrails

Never do these as a reaction to an ordinary missing-message report:

- Set `syncFullHistory: true` or force full history processing.
- Clear/move `auth/`.
- Delete `data/mirror.sqlite`, `data/messages.json` or `data/aliases.json`.
- Re-link the device just to obtain a message older than the seven-day policy.

Those actions either widen the privacy scope or force an unnecessary QR. State
the trade-off and get the user's explicit agreement first.
