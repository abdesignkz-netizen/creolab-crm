const SECRET_KEYS =
  /secret|password|passwd|token|authorization|cookie|sessionid|accesstoken|refreshtoken|apikey|apisecret|credential|privatekey|encrypted|pem|nca|pin|certificate/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key)) {
      next[key] = item == null || item === "" ? item : "[REDACTED]";
      continue;
    }
    next[key] = redactSensitive(item);
  }
  return next;
}

export function logServerError(error: unknown) {
  if (error instanceof Error) {
    console.error(error.name, error.message);
    if (error.stack) console.error(error.stack.split("\n").slice(0, 12).join("\n"));
    return;
  }
  console.error("server_error");
}
