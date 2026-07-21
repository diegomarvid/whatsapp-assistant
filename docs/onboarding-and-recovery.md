# Onboarding, cache and recovery

This is the operational source of truth for the local WhatsApp assistant.
Its goal is to make the normal path reliable without repeatedly asking the user
to scan a QR code.

## Normal operating mode

- Baileys can run as a local macOS LaunchAgent (for example,
  `com.example.whatsapp-assistant`).
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

1. Install dependencies and the local CLI:

   ```bash
   npm install
   npm link
   ```

2. Load or start the LaunchAgent:

   ```bash
   launchctl bootstrap gui/$(id -u) \
     "$HOME/Library/LaunchAgents/com.example.whatsapp-assistant.plist"
   ```

3. Scan the QR shown at `data/link-qr.png` only if `auth/` has not been
   created yet, or WhatsApp explicitly logged the device out.
4. Wait for `wa status` to report `"connection": "open"`. The cache count can
   rise for a little while after that as the recent sync arrives.

After this first link, do not scan again just because a query looks old. First
check the cache window and service health below.

## Everyday CLI

```bash
wa status
wa aliases
wa alias add contacto +598XXXXXXXX "Nombre del contacto"
wa find "Nombre del contacto"
wa latest contacto
wa latest-incoming contacto
wa history contacto 20
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
3. Runs `ct transcribe <audio> es`.
4. Prints the transcript. It does not send anything to the contact.

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
   launchctl print gui/$(id -u)/com.example.whatsapp-assistant
   ```

2. If it is not `open`, restart the existing service only:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.example.whatsapp-assistant
   ```

   Wait a few seconds and run `wa status` again. This preserves the linked
   session and normally reconnects without interaction.

3. If a conversation seems to be missing, inspect `wa status` and `wa coverage
   contacto`, then `wa latest-incoming contacto`. The observer automatically
   reconnects with the existing linked session and the CLI resolves the current
   LID before reading it. Messages older than seven days are intentionally
   absent. The assistant is for recent operational context, not an archive.

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
