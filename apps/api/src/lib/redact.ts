const SECRET_KEYS =
  /secret|password|passwd|token|authorization|cookie|sessionid|accesstoken|refreshtoken|apikey|apisecret|credential|privatekey|encrypted|pem|nca|pin|certificate|codehash|verificationcode|resetcode/i;

const NOT_A_LEAF = Symbol("not-a-leaf");

/** Dates and Decimal (and other class instances) must become JSON before Object.entries.
 *  Decimal exposes an enumerable `constructor` function, which Prisma refuses to store. */
function jsonLeaf(value: object): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return NOT_A_LEAF;
  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON !== "function") return NOT_A_LEAF;
  try {
    const encoded = toJSON.call(value);
    if (encoded === value || typeof encoded === "function") return NOT_A_LEAF;
    return encoded;
  } catch {
    return NOT_A_LEAF;
  }
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  const leaf = jsonLeaf(value);
  if (leaf !== NOT_A_LEAF) return redactSensitive(leaf);
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "function") continue;
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
