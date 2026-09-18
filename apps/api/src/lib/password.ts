import argon2 from "argon2";

/** Explicit argon2id; matches library defaults already stored in existing hashes. */
export const ARGON2_OPTIONS: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

export function hashPassword(password: string) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}
