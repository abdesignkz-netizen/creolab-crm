import { createHash, X509Certificate } from "node:crypto";
import forge from "node-forge";

export type InspectedCertificate = {
  serial: string;
  issuer: string;
  subject: string;
  validFrom: Date | null;
  validTo: Date | null;
  iin: string | null;
  bin: string | null;
  commonName: string | null;
};

export type CmsInspection = {
  certificates: InspectedCertificate[];
  primary: InspectedCertificate | null;
  primaryPem: string | null;
  detached: boolean;
};

export function extractIin(value: string | null | undefined) {
  const text = String(value || "");
  const tagged = text.match(/IIN\s*(\d{12})/i);
  if (tagged) return tagged[1];
  const digits = text.replace(/\D+/g, "");
  return digits.length === 12 ? digits : null;
}

export function extractBin(value: string | null | undefined) {
  const text = String(value || "");
  const tagged = text.match(/BIN\s*(\d{12})/i);
  if (tagged) return tagged[1];
  return null;
}

export function decodeCmsDer(cmsBase64: string) {
  const cleaned = String(cmsBase64 || "")
    .replace(/-----BEGIN CMS-----/g, "")
    .replace(/-----END CMS-----/g, "")
    .replace(/\s+/g, "");
  if (!cleaned) throw new Error("empty_cms");
  return Buffer.from(cleaned, "base64");
}

const children = (node?: forge.asn1.Asn1): forge.asn1.Asn1[] => Array.isArray(node?.value) ? node.value as forge.asn1.Asn1[] : [];
const derBytes = (node: forge.asn1.Asn1) => forge.asn1.toDer(node).getBytes();
const serialHex = (node: forge.asn1.Asn1) => Buffer.from(node.value as string, "binary").toString("hex").replace(/^0+/, "").toLowerCase() || "0";

function subjectKeyId(certificate: forge.asn1.Asn1) {
  const tbs = children(certificate)[0];
  const extensions = children(tbs).find((node) => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 3);
  for (const extension of children(children(extensions)[0])) {
    const fields = children(extension);
    if (forge.asn1.derToOid(fields[0].value as string) === "2.5.29.14") {
      return forge.asn1.fromDer(fields.at(-1)!.value as string).value;
    }
  }
  return null;
}

export function inspectCms(cmsBase64: string): CmsInspection {
  const der = decodeCmsDer(cmsBase64);
  if (der.length < 16 || der[0] !== 0x30) {
    throw new Error("invalid_cms");
  }
  const root = children(forge.asn1.fromDer(der.toString("binary")));
  if (root[0]?.type !== forge.asn1.Type.OID || forge.asn1.derToOid(root[0].value as string) !== "1.2.840.113549.1.7.2") throw new Error("cms_not_signed_data");
  const signedData = children(children(root[1])[0]);
  const certSet = signedData.slice(3).find((node) => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0);
  const signerSet = signedData.at(-1);
  if (signerSet?.type !== forge.asn1.Type.SET || children(signerSet).length !== 1) throw new Error("cms_requires_one_signer");
  const sid = children(children(signerSet)[0])[1];
  const entries = children(certSet).filter((node) => node.tagClass === forge.asn1.Class.UNIVERSAL && node.type === forge.asn1.Type.SEQUENCE).map((node) => {
    const pem = normalizeCertificatePem(Buffer.from(derBytes(node), "binary").toString("base64"));
    // Read X.509 metadata without forge's RSA-only public-key decoder.
    const certificate = inspectCertificatePem(pem);
    const tbs = children(children(node)[0]);
    const offset = tbs[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
    const matches = sid?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && sid.type === 0
      ? subjectKeyId(node) === sid.value
      : sid?.type === forge.asn1.Type.SEQUENCE && children(sid).length === 2
        && serialHex(tbs[offset]) === serialHex(children(sid)[1])
        && derBytes(tbs[offset + 2]) === derBytes(children(sid)[0]);
    return { certificate, pem, matches };
  });
  const signers = entries.filter((entry) => entry.matches);
  const signer = signers.length === 1 ? signers[0] : null;
  return { detached: children(signedData[2]).length === 1, certificates: entries.map((entry) => entry.certificate), primary: signer?.certificate || null, primaryPem: signer?.pem || null };
}

export function publicCertificateFingerprint(pem: string) {
  const normalized = normalizeCertificatePem(pem);
  const body = normalized
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (!body) return "";
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex");
}

export function normalizeCertificatePem(value: string) {
  const trimmed = String(value || "").replace(/\\n/g, "\n").trim();
  if (!trimmed) return "";
  if (/BEGIN CERTIFICATE/.test(trimmed)) return trimmed;
  const body = trimmed.replace(/\s+/g, "");
  if (!body) return "";
  const wrapped = body.match(/.{1,64}/g)?.join("\n") || body;
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

export function inspectCertificatePem(pem: string): InspectedCertificate {
  // X.509 metadata does not require RSA/GOST key operations or signature verification.
  const cert = new X509Certificate(normalizeCertificatePem(pem));
  const subject = cert.subject.replace(/\n/g, ", ");
  return {
    serial: cert.serialNumber.toLowerCase(),
    issuer: cert.issuer.replace(/\n/g, ", "),
    subject,
    validFrom: new Date(cert.validFrom),
    validTo: new Date(cert.validTo),
    iin: extractIin(subject),
    bin: extractBin(subject),
    commonName: cert.subject.match(/(?:^|\n)CN=(.*)(?:\n|$)/)?.[1] || null,
  };
}

export function pemFromCms(cmsBase64: string) {
  const inspection = inspectCms(cmsBase64);
  if (!inspection.primaryPem) throw new Error("cms_has_no_signer_certificate");
  return inspection.primaryPem;
}

/** Read extension bits and OIDs without forge's RSA-only public-key decoder.
 * This is metadata inspection; it does not validate a chain or a signature.
 */
export function inspectCertificateUsage(pem: string) {
  const certificate = new X509Certificate(normalizeCertificatePem(pem));
  const root = forge.asn1.fromDer(certificate.raw.toString("binary"));
  const children = (node: forge.asn1.Asn1) => Array.isArray(node.value) ? node.value as forge.asn1.Asn1[] : [];
  const [tbs, algorithm] = children(root);
  const signatureOid = children(algorithm)[0];
  const extensions = children(tbs).find(n => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === 3);
  const eku: string[] = [], keyUsage: string[] = [];
  for (const extension of extensions ? children(children(extensions)[0]) : []) {
    const fields = children(extension);
    const oid = forge.asn1.derToOid(fields[0].value as string);
    if (oid !== "2.5.29.15" && oid !== "2.5.29.37") continue;
    const value = forge.asn1.fromDer(fields[fields.length - 1].value as string);
    if (oid === "2.5.29.37") {
      for (const item of children(value)) {
        const id = forge.asn1.derToOid(item.value as string);
        eku.push(forge.pki.oids[id] || id);
      }
    } else {
      const bits = value.value as string;
      const names = ["digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment", "keyAgreement", "keyCertSign", "cRLSign", "encipherOnly", "decipherOnly"];
      names.forEach((name, index) => {
        if ((bits.charCodeAt(1 + Math.floor(index / 8)) || 0) & (0x80 >> (index % 8))) keyUsage.push(name);
      });
    }
  }
  return { eku, keyUsage, signatureAlgorithm: forge.asn1.derToOid(signatureOid.value as string) };
}
