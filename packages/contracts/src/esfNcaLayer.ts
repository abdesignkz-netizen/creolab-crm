/**
 * Official NCALayer add-on «Модуль ИС ЭСФ» v1.2 websocket contract.
 *
 * Verified against the installed official bundle (Bundle-SymbolicName
 * com.osdkz.esf.signer, Bundle-Version 1.2), ModuleServiceImpl bytecode,
 * and the request shape used by the official ИС ЭСФ test stand.
 *
 * Do not use kz.gov.pki.knca.basics cms/xml for AVR/ЭСФ document signing.
 * basics remains for contracts, generic CMS/XML, and AUTH cert extract.
 */

export const NCALAYER_ACCESSORY_MODULE = "kz.gov.pki.ncalayerservices.accessory";
export const NCALAYER_ACCESSORY_GET_BUNDLES = "getBundles";
export const NCALAYER_ACCESSORY_GET_SERVICES = "getServices";

export const ESF_NCALAYER_BUNDLE_SYMBOLIC_NAME = "com.osdkz.esf.signer";
export const ESF_NCALAYER_BUNDLE_NAME = "EsfSigner";
export const ESF_NCALAYER_BUNDLE_VERSION = "1.2";
export const ESF_NCALAYER_SERVICE = "com.osdkz.esf.signer.esfSigner";
export const ESF_NCALAYER_SIGN_PLAIN_DATA = "signPlainData";
export const ESF_NCALAYER_SIGN_PLAIN_DATA_MAP = "signPlainDataMap";
export const ESF_NCALAYER_AUTH = "auth";
export const ESF_NCALAYER_METHODS = [
  ESF_NCALAYER_SIGN_PLAIN_DATA,
  ESF_NCALAYER_SIGN_PLAIN_DATA_MAP,
  ESF_NCALAYER_AUTH,
] as const;

/** Official test-stand storage for a local .p12. PIN stays inside NCALayer. */
export const ESF_NCALAYER_STORAGE_PKCS12 = "PKCS12";

export const ESF_NCALAYER_STORAGES = [
  "PKCS12",
  "AKKaztokenStore",
  "AKKZIDCardStore",
  "AKEToken72KStore",
  "AKEToken5110Store",
  "AKJaCartaStore",
  "AKAKEYStore",
] as const;

export const UNOFFICIAL_ESF_NCA_SERVICES = ["kz.uchet.esfSignUtil"] as const;

export const ESF_MODULE_REQUIRED_MESSAGE =
  "Для работы с ИС ЭСФ необходимо установить официальный модуль ИС ЭСФ в NCALayer";

export type EsfSignerKeyInfo = {
  alias?: string;
  keyId?: string;
  algorithm?: string;
  subjectCn?: string;
  subjectDn?: string;
  issuerCn?: string;
  issuerDn?: string;
  serialNumber?: string;
  certNotAfter?: string;
  certNotBefore?: string;
  authorityKeyIdentifier?: string;
};

export type EsfPlainSignature = {
  signature: string;
  publicCertificate: string;
  keyInfo: EsfSignerKeyInfo;
  code: string;
};

export type EsfSignerParseError = {
  ok: false;
  code: "USER_CANCELLED" | "SIGNATURE_FAILED" | "MODULE_NOT_FOUND" | "INVALID_RESPONSE";
  message: string;
};

export type EsfSignerParseOk = { ok: true } & EsfPlainSignature;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function unwrapNcalayerBody(payload: unknown): unknown {
  const root = asRecord(payload);
  if (!root) return payload;
  const body = asRecord(root.body);
  if (body && "result" in body) return body.result;
  if ("result" in root && root.result != null) return root.result;
  return payload;
}

function responseObjectOf(payload: unknown): Record<string, unknown> | null {
  const unwrapped = unwrapNcalayerBody(payload);
  if (typeof unwrapped === "string") {
    try {
      return responseObjectOf(JSON.parse(unwrapped));
    } catch {
      return null;
    }
  }
  const root = asRecord(unwrapped);
  if (!root) return null;
  const nested = asRecord(root.responseObject);
  if (nested) return nested;
  if (root.signature || root.pem || root.keyInfo) return root;
  return root;
}

function publicCertificateOf(responseObject: Record<string, unknown>, keyInfo: Record<string, unknown> | null) {
  return (
    asString(responseObject.pem) ||
    asString(keyInfo?.pem) ||
    asString(keyInfo?.base64Pem) ||
    asString(keyInfo?.certificate) ||
    asString(responseObject.certificate)
  );
}

function keyInfoOf(responseObject: Record<string, unknown>): EsfSignerKeyInfo {
  const raw = asRecord(responseObject.keyInfo) || asRecord(responseObject.authKeyInfo) || {};
  return {
    alias: asString(raw.alias) || undefined,
    keyId: asString(raw.keyId) || undefined,
    algorithm: asString(raw.algorithm) || undefined,
    subjectCn: asString(raw.subjectCn) || undefined,
    subjectDn: asString(raw.subjectDn) || undefined,
    issuerCn: asString(raw.issuerCn) || undefined,
    issuerDn: asString(raw.issuerDn) || undefined,
    serialNumber: asString(raw.serialNumber) || undefined,
    certNotAfter: asString(raw.certNotAfter) || undefined,
    certNotBefore: asString(raw.certNotBefore) || undefined,
    authorityKeyIdentifier: asString(raw.authorityKeyIdentifier) || undefined,
  };
}

export function isUnofficialEsfService(name: string) {
  const value = String(name || "").toLowerCase();
  return UNOFFICIAL_ESF_NCA_SERVICES.some((item) => value === item.toLowerCase() || value.includes("uchet"));
}

export function isOfficialEsfService(name: string) {
  const value = String(name || "");
  if (isUnofficialEsfService(value)) return false;
  return value === ESF_NCALAYER_SERVICE || /osdkz\.esf\.signer/i.test(value);
}

export function isOfficialEsfBundle(name: string) {
  const value = String(name || "");
  if (/uchet/i.test(value)) return false;
  return value === ESF_NCALAYER_BUNDLE_SYMBOLIC_NAME || /osdkz\.esf\.signer/i.test(value);
}

export function findOfficialEsfService(services: unknown): string | null {
  const list = Array.isArray(services)
    ? services
    : asRecord(services)?.services;
  if (!Array.isArray(list)) return null;
  const names = list.map((item) => String(item || ""));
  return names.find((name) => isOfficialEsfService(name)) || null;
}

export function findOfficialEsfBundle(bundles: unknown): { name: string; version: string } | null {
  const root = asRecord(unwrapNcalayerBody(bundles)) || asRecord(bundles);
  if (!root) return null;
  for (const [name, version] of Object.entries(root)) {
    if (isOfficialEsfBundle(name)) {
      return { name, version: String(version || "") };
    }
  }
  return null;
}

export function parseEsfSignerResponse(payload: unknown): EsfSignerParseOk | EsfSignerParseError {
  const root = asRecord(payload);
  const statusFalse = root && (root.status === false || root.success === false);
  const errorCode = asString(root?.errorCode || root?.code);
  const message = asString(root?.message || root?.details);
  if (statusFalse && /MODULE_NOT_FOUND/i.test(errorCode || message)) {
    return { ok: false, code: "MODULE_NOT_FOUND", message: ESF_MODULE_REQUIRED_MESSAGE };
  }

  const unwrapped = unwrapNcalayerBody(payload);
  const parsed =
    typeof unwrapped === "string"
      ? (() => {
          try {
            return asRecord(JSON.parse(unwrapped));
          } catch {
            return null;
          }
        })()
      : asRecord(unwrapped);
  const code = asString(parsed?.code || errorCode);
  const text = asString(parsed?.message || message);

  if (/action\.canceled|cancel|отмен/i.test(text) || code === "500" && /cancel/i.test(text)) {
    return { ok: false, code: "USER_CANCELLED", message: text || "Подпись отменена" };
  }
  if (code && code !== "200" && !asRecord(parsed?.responseObject)?.signature) {
    if (/MODULE_NOT_FOUND/i.test(code + text)) {
      return { ok: false, code: "MODULE_NOT_FOUND", message: ESF_MODULE_REQUIRED_MESSAGE };
    }
    return { ok: false, code: "SIGNATURE_FAILED", message: text || code || "Модуль ИС ЭСФ не подписал данные" };
  }

  const responseObject = responseObjectOf(payload);
  const signature = asString(responseObject?.signature);
  if (!signature) {
    if (statusFalse) {
      return { ok: false, code: "SIGNATURE_FAILED", message: text || "Модуль ИС ЭСФ не вернул подпись" };
    }
    return { ok: false, code: "INVALID_RESPONSE", message: "Модуль ИС ЭСФ вернул ответ без signature" };
  }

  const keyInfo = keyInfoOf(responseObject || {});
  return {
    ok: true,
    signature,
    publicCertificate: publicCertificateOf(responseObject || {}, asRecord(responseObject?.keyInfo)),
    keyInfo,
    code: code || "200",
  };
}

export function sanitizeEsfSignerPublicMeta(result: EsfPlainSignature) {
  return {
    code: result.code,
    signatureLength: result.signature.length,
    hasPublicCertificate: Boolean(result.publicCertificate),
    algorithm: result.keyInfo.algorithm || null,
    subjectCn: result.keyInfo.subjectCn || null,
    issuerCn: result.keyInfo.issuerCn || null,
    serialNumber: result.keyInfo.serialNumber || null,
    certNotBefore: result.keyInfo.certNotBefore || null,
    certNotAfter: result.keyInfo.certNotAfter || null,
  };
}

export function buildEsfSignPlainDataRequest(payload: string, storageName = ESF_NCALAYER_STORAGE_PKCS12) {
  return {
    module: ESF_NCALAYER_SERVICE,
    method: ESF_NCALAYER_SIGN_PLAIN_DATA,
    storageName,
    data: payload,
  };
}

export function buildEsfAuthRequest(data: string, storageName = ESF_NCALAYER_STORAGE_PKCS12) {
  return {
    module: ESF_NCALAYER_SERVICE,
    method: ESF_NCALAYER_AUTH,
    storageName,
    data,
  };
}

const SECRET_KEYS = /^(pem|certificate|base64pem|signature|data|password|pin|privatekey)$/i;

export function sanitizeUnknownEsfResponse(payload: unknown): unknown {
  if (typeof payload === "string") {
    if (/-----BEGIN CERTIFICATE-----/.test(payload) || (payload.length > 80 && /^[A-Za-z0-9+/=\s-]+$/.test(payload))) {
      return { present: true, length: payload.length, preview: "redacted" };
    }
    return payload.length > 240 ? `${payload.slice(0, 120)}…` : payload;
  }
  if (Array.isArray(payload)) return payload.map((item) => sanitizeUnknownEsfResponse(item));
  const root = asRecord(payload);
  if (!root) return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (SECRET_KEYS.test(key) && typeof value === "string") {
      out[key] = { present: Boolean(value), length: value.length };
      continue;
    }
    out[key] = sanitizeUnknownEsfResponse(value);
  }
  return out;
}

/** Walk an unknown NCALayer response and pick a public certificate if present. */
export function extractPublicCertificateFromUnknown(payload: unknown): string {
  const pemBlocks: string[] = [];
  const named: string[] = [];
  function walk(value: unknown, key = "") {
    if (typeof value === "string") {
      if (/-----BEGIN CERTIFICATE-----/.test(value)) {
        pemBlocks.push(value);
        return;
      }
      if (/^(pem|base64pem|certificate|x509certificate|publiccertificate)$/i.test(key) && value.length > 80) {
        named.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, key));
      return;
    }
    const root = asRecord(value);
    if (!root) return;
    for (const [next, child] of Object.entries(root)) walk(child, next);
  }
  walk(payload);
  return pemBlocks[0] || named[0] || "";
}
