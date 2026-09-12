/** Structural analysis of an ESF signature string. Never prints the payload. */

export type SignatureAnalysis = {
  empty: boolean;
  length: number;
  encoding: "empty" | "xml" | "base64" | "unknown";
  format: "empty" | "xmldsig" | "cms_or_asn1" | "raw_64" | "unknown";
  detachedGuess: "unknown" | "likely_detached" | "likely_attached";
  asn1Sequence: boolean;
  looksLikeCms: boolean;
  xmlDsig: boolean;
  ncalayerCandidates: Array<"cms" | "xml">;
};

function looksLikeBase64(value: string) {
  return /^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s+/g, "").length >= 16;
}

export function analyzeEsfSignature(value: string): SignatureAnalysis {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return {
      empty: true,
      length: 0,
      encoding: "empty",
      format: "empty",
      detachedGuess: "unknown",
      asn1Sequence: false,
      looksLikeCms: false,
      xmlDsig: false,
      ncalayerCandidates: [],
    };
  }
  if (trimmed.startsWith("<")) {
    const xmlDsig = /<([a-zA-Z0-9]+:)?Signature[\s>]/.test(trimmed);
    return {
      empty: false,
      length: trimmed.length,
      encoding: "xml",
      format: xmlDsig ? "xmldsig" : "unknown",
      detachedGuess: xmlDsig ? "likely_detached" : "unknown",
      asn1Sequence: false,
      looksLikeCms: false,
      xmlDsig,
      ncalayerCandidates: xmlDsig ? ["xml"] : [],
    };
  }
  const body = trimmed
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!looksLikeBase64(body)) {
    return {
      empty: false,
      length: trimmed.length,
      encoding: "unknown",
      format: "unknown",
      detachedGuess: "unknown",
      asn1Sequence: false,
      looksLikeCms: false,
      xmlDsig: false,
      ncalayerCandidates: [],
    };
  }
  const der = Buffer.from(body, "base64");
  const asn1Sequence = der[0] === 0x30;
  const oidCms = der.includes(Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]));
  const looksLikeCms = asn1Sequence && (oidCms || der.length > 80);
  const raw64 = !asn1Sequence && der.length === 64;
  return {
    empty: false,
    length: der.length,
    encoding: "base64",
    format: looksLikeCms || asn1Sequence ? "cms_or_asn1" : raw64 ? "raw_64" : "unknown",
    detachedGuess: looksLikeCms || raw64 ? "likely_detached" : "unknown",
    asn1Sequence,
    looksLikeCms,
    xmlDsig: false,
    ncalayerCandidates: looksLikeCms || asn1Sequence ? ["cms"] : [],
  };
}
