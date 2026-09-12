import { createHash } from "node:crypto";
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
};

function rdn(cert: forge.pki.Certificate, shortName: string) {
  return cert.subject.getField(shortName)?.value || null;
}

function issuerDn(cert: forge.pki.Certificate) {
  return cert.issuer.attributes.map((attr) => `${attr.shortName || attr.name}=${attr.value}`).join(", ");
}

function subjectDn(cert: forge.pki.Certificate) {
  return cert.subject.attributes.map((attr) => `${attr.shortName || attr.name}=${attr.value}`).join(", ");
}

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

function describeCertificate(cert: forge.pki.Certificate): InspectedCertificate {
  const fields = cert.subject.attributes.map((attr) => String(attr.value || ""));
  const joined = [subjectDn(cert), ...fields].join(" ");
  return {
    serial: cert.serialNumber || "",
    issuer: issuerDn(cert),
    subject: subjectDn(cert),
    validFrom: cert.validity.notBefore || null,
    validTo: cert.validity.notAfter || null,
    iin: extractIin(joined),
    bin: extractBin(joined),
    commonName: rdn(cert, "CN"),
  };
}

export function decodeCmsDer(cmsBase64: string) {
  const cleaned = String(cmsBase64 || "")
    .replace(/-----BEGIN CMS-----/g, "")
    .replace(/-----END CMS-----/g, "")
    .replace(/\s+/g, "");
  if (!cleaned) throw new Error("empty_cms");
  return Buffer.from(cleaned, "base64");
}

function collectCertificates(node: forge.asn1.Asn1, out: forge.pki.Certificate[]) {
  try {
    const cert = forge.pki.certificateFromAsn1(node);
    if (cert.serialNumber && cert.validity?.notBefore) out.push(cert);
  } catch {
    /* not a certificate */
  }
  if (Array.isArray(node.value)) {
    for (const child of node.value) {
      if (child && typeof child === "object" && "value" in child) {
        collectCertificates(child as forge.asn1.Asn1, out);
      }
    }
  }
}

export function inspectCms(cmsBase64: string): CmsInspection {
  const der = decodeCmsDer(cmsBase64);
  if (der.length < 16 || der[0] !== 0x30) {
    throw new Error("invalid_cms");
  }
  const asn1 = forge.asn1.fromDer(der.toString("binary"));
  const certificates: forge.pki.Certificate[] = [];
  collectCertificates(asn1, certificates);
  const described = certificates.map(describeCertificate);
  const unique = described.filter(
    (cert, index) => described.findIndex((item) => item.serial === cert.serial && item.subject === cert.subject) === index,
  );
  return { certificates: unique, primary: unique[0] || null };
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
  const cert = forge.pki.certificateFromPem(normalizeCertificatePem(pem));
  return describeCertificate(cert);
}

export function pemFromCms(cmsBase64: string) {
  const der = decodeCmsDer(cmsBase64);
  if (der.length < 16 || der[0] !== 0x30) {
    throw new Error("invalid_cms");
  }
  const asn1 = forge.asn1.fromDer(der.toString("binary"));
  const certificates: forge.pki.Certificate[] = [];
  collectCertificates(asn1, certificates);
  if (!certificates[0]) throw new Error("cms_has_no_certificate");
  return forge.pki.certificateToPem(certificates[0]);
}
