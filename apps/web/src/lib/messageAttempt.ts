type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Keep only a digest and a random key, never customer text or file contents. */
export async function messageAttempt(scope: string, payload: unknown, storage?: Store) {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const slot = `basqar-send:${scope}:${hash}`;
  let key: string | null = null;
  try { key = storage?.getItem(slot) || null; } catch { /* Storage may be disabled. */ }
  key ||= crypto.randomUUID();
  try { storage?.setItem(slot, key); } catch { /* The caller retains it in memory. */ }
  return { key, hash, clear() { try { storage?.removeItem(slot); } catch { /* Best effort. */ } } };
}
