async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyFrozenAvrPayload(prepared: { payload: string; byteLength: number; payloadSha256: string }) {
  const bytes = new TextEncoder().encode(prepared.payload);
  if (bytes.length !== prepared.byteLength || await sha256(bytes) !== prepared.payloadSha256) {
    throw new Error("SHA-256 или длина XML не совпали. Подпись и отправка остановлены.");
  }
}

/** Called on the certificate returned by the same signPlainData response. */
export async function signPlainDataPemFingerprint(pem: string) {
  const body = pem.replace(/\\n/g, "\n").replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  return sha256(Uint8Array.from(atob(body), (char) => char.charCodeAt(0)));
}
