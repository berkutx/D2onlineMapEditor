/**
 * Anonymous persistent browser identity (no accounts):
 *
 *  - clientId  — the OWNERSHIP token. Sent as `x-client-id` on REST calls (and socket auth)
 *    so the server can tag uploads/new maps with their creator and list them only to them.
 *    NEVER put it in a URL: anyone holding it could list your maps.
 *  - channelId — the default collab CHANNEL. The socket room key is `mapId#channel`, so two
 *    visitors of the same map share edits only when they share the channel. The share link
 *    exposes this value (?room=<channel>) — which is exactly why it is a SEPARATE uuid from
 *    the ownership token.
 */

function persistentUuid(key: string): string {
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return "anonymous"; // storage unavailable (private mode) — degraded but functional
  }
}

export const getClientId = (): string => persistentUuid("d2.clientId");
export const getChannelId = (): string => persistentUuid("d2.channelId");
