import forge from "node-forge";
import { extractBin, extractIin, inspectCertificatePem, normalizeCertificatePem } from "../../../services/cmsInspect.ts";

export type SanitizedCertificateDiagnosis = {
  subject: string;
  issuer: string;
  serial: string;
  validFrom: string | null;
  validTo: string | null;
  validNow: boolean;
  eku: string[];
  ekuAuth: boolean;
  ekuSign: boolean;
  keyUsage: string[];
  bin: string | null;
  iin: string | null;
  commonName: string | null;
  signatureAlgorithm: string | null;
  caEnvironment: "test" | "prod" | "unknown";
  x509Format: {
    hasPemHeaders: boolean;
    newline: "lf" | "crlf" | "none";
    bodyLength: number;
    derBytes: number;
    sentToCreateSessionAs: "pem_with_headers_xml_escaped";
  };
  likelyCertificateNotValidReasons: string[];
};

function extensionList(cert: forge.pki.Certificate, name: string) {
  const ext = cert.getExtension(name) as Record<string, unknown> | null;
  if (!ext) return [] as string[];
  return Object.entries(ext)
    .filter(([key, value]) => value === true && key !== "critical" && key !== "name" && key !== "id")
    .map(([key]) => key);
}

function caEnvironment(issuer: string): SanitizedCertificateDiagnosis["caEnvironment"] {
  if (/тест|test/i.test(issuer)) return "test";
  if (/ұлттық куәландырушы орталық|national certification authority|нұц|нуц|nca of/i.test(issuer)) {
    return "prod";
  }
  return "unknown";
}

function officialFaultCode(message: string) {
  const text = String(message || "");
  const match = text.match(/\b(CERTIFICATE_NOT_VALID|CERTIFICATE_EXPIRED|CERTIFICATE_REVOKED|INVALID_CERTIFICATE)\b/);
  return match?.[1] || "";
}

export function diagnosePublicCertificate(
  pem: string,
  options?: { expectedEnv?: "test" | "prod" | "local" | "off"; expectedBin?: string | null; lastFault?: string },
): SanitizedCertificateDiagnosis {
  const normalized = normalizeCertificatePem(pem);
  const cert = forge.pki.certificateFromPem(normalized);
  const inspected = inspectCertificatePem(normalized);
  const eku = extensionList(cert, "extKeyUsage");
  const keyUsage = extensionList(cert, "keyUsage");
  const body = normalized
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(body, "base64");
  const issuer = inspected.issuer;
  const env = caEnvironment(issuer);
  const validNow = Boolean(
    inspected.validFrom &&
      inspected.validTo &&
      inspected.validFrom.getTime() <= Date.now() &&
      inspected.validTo.getTime() > Date.now(),
  );
  const ekuAuth = eku.includes("clientAuth");
  const ekuSign = eku.includes("emailProtection");
  const reasons: string[] = [];
  const expectedEnv = options?.expectedEnv;
  if (expectedEnv === "test" && env === "prod") {
    reasons.push("Сертификат выдан боевым УЦ, а createSession идёт в TEST ИС ЭСФ. TEST обычно принимает только тестовый УЦ.");
  }
  if (expectedEnv === "prod" && env === "test") {
    reasons.push("Сертификат тестового УЦ отправляется в боевой ИС ЭСФ.");
  }
  if (!validNow) reasons.push("Срок действия сертификата не покрывает текущую дату.");
  if (!ekuAuth && ekuSign) {
    reasons.push("В сертификате есть EKU подписи, но нет clientAuth. createSession ждёт AUTH-сертификат, не SIGN.");
  }
  if (!ekuAuth && !ekuSign) {
    reasons.push("Не удалось прочитать EKU. Если это SIGN-ключ, TEST createSession вернёт CERTIFICATE_NOT_VALID.");
  }
  if (options?.expectedBin && inspected.bin && inspected.bin !== options.expectedBin) {
    reasons.push("БИН в сертификате не совпадает с БИН организации / tin createSession.");
  }
  reasons.push(
    "x509Certificate сейчас уходит как PEM с заголовками через xmlEscape, не CDATA. Если WSDL ждёт только base64 DER, TEST ответит CERTIFICATE_NOT_VALID. Формат не меняем до отдельного решения.",
  );
  const fault = officialFaultCode(options?.lastFault || "");
  if (fault === "CERTIFICATE_NOT_VALID" && !reasons.some((item) => item.includes("боевым УЦ"))) {
    reasons.unshift("Официальный fault после успешного WSSE: CERTIFICATE_NOT_VALID — кабинет принял пароль, но отклонил сам сертификат.");
  }

  return {
    subject: inspected.subject,
    issuer,
    serial: inspected.serial,
    validFrom: inspected.validFrom?.toISOString() || null,
    validTo: inspected.validTo?.toISOString() || null,
    validNow,
    eku,
    ekuAuth,
    ekuSign,
    keyUsage,
    bin: inspected.bin || extractBin(inspected.subject),
    iin: inspected.iin || extractIin(inspected.subject),
    commonName: inspected.commonName,
    signatureAlgorithm: cert.siginfo?.algorithmOid || cert.signatureOid || null,
    caEnvironment: env,
    x509Format: {
      hasPemHeaders: /BEGIN CERTIFICATE/.test(normalized),
      newline: normalized.includes("\r\n") ? "crlf" : normalized.includes("\n") ? "lf" : "none",
      bodyLength: body.length,
      derBytes: der.length,
      sentToCreateSessionAs: "pem_with_headers_xml_escaped",
    },
    likelyCertificateNotValidReasons: reasons,
  };
}

export function officialEsfFaultCode(message: string) {
  return officialFaultCode(message);
}
