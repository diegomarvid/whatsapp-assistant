// Baileys delivers events in batches, and one batch can carry messages.upsert
// next to an unrelated update. WhatsApp never redelivers what the companion
// already acknowledged, so a handler that throws must not take the rest of
// the batch down with it: each event runs on its own, in the given order, and
// a failure is reported with the name of the event that caused it.
export async function processEventBatch(events, handlers, onError) {
  for (const [name, handle] of handlers) {
    if (events?.[name] === undefined) continue
    try {
      await handle(events[name])
    } catch (error) {
      await onError(name, error)
    }
  }
}
