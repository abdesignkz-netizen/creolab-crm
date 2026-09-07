/** Untrusted query parameters must not produce negative/NaN database limits. */
export function pagination(query: Record<string, string | undefined>, defaultLimit = 50) {
  const size = Number(query.limit ?? defaultLimit);
  const start = Number(query.offset ?? 0);
  return {
    take: Number.isFinite(size) && size > 0 ? Math.min(100, Math.max(1, Math.floor(size))) : defaultLimit,
    skip: Number.isSafeInteger(start) && start >= 0 ? start : 0,
  };
}
