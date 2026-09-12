import { inspectCms, type CmsInspection } from "./cmsInspect.ts";

export type SignatureVerification = {
  status: "PARSED" | "FAILED";
  cryptoStatus: "UNAVAILABLE";
  authorityStatus: "UNCHECKED";
  inspection: CmsInspection | null;
  details: Record<string, unknown>;
};

/** Серверная проверка CMS. Крипто GOST НУЦ — только через официальный Kalkan, его в репо нет. */
export function verifyDocumentSignature(input: {
  cmsBase64: string;
  documentHash: string;
  expectedBin?: string | null;
}): SignatureVerification {
  let inspection: CmsInspection;
  try {
    inspection = inspectCms(input.cmsBase64);
  } catch {
    return {
      status: "FAILED",
      cryptoStatus: "UNAVAILABLE",
      authorityStatus: "UNCHECKED",
      inspection: null,
      details: { error: "cms_parse_failed" },
    };
  }
  const cert = inspection.primary;
  if (!cert) {
    return {
      status: "FAILED",
      cryptoStatus: "UNAVAILABLE",
      authorityStatus: "UNCHECKED",
      inspection,
      details: { error: "certificate_missing" },
    };
  }
  const now = new Date();
  if (cert.validFrom && cert.validFrom > now) {
    return {
      status: "FAILED",
      cryptoStatus: "UNAVAILABLE",
      authorityStatus: "UNCHECKED",
      inspection,
      details: { error: "certificate_not_yet_valid" },
    };
  }
  if (cert.validTo && cert.validTo < now) {
    return {
      status: "FAILED",
      cryptoStatus: "UNAVAILABLE",
      authorityStatus: "UNCHECKED",
      inspection,
      details: { error: "certificate_expired" },
    };
  }
  if (!cert.iin) {
    return {
      status: "FAILED",
      cryptoStatus: "UNAVAILABLE",
      authorityStatus: "UNCHECKED",
      inspection,
      details: { error: "signer_iin_missing" },
    };
  }
  const warnings: string[] = [];
  if (input.expectedBin && cert.bin && cert.bin !== input.expectedBin) {
    return {
      status: "FAILED",
      cryptoStatus: "UNAVAILABLE",
      authorityStatus: "UNCHECKED",
      inspection,
      details: { error: "bin_mismatch", expectedBin: input.expectedBin, certificateBin: cert.bin },
    };
  }
  if (input.expectedBin && !cert.bin) {
    warnings.push("certificate_bin_absent");
  }
  return {
    status: "PARSED",
    cryptoStatus: "UNAVAILABLE",
    authorityStatus: "UNCHECKED",
    inspection,
    details: {
      documentHash: input.documentHash,
      crypto: "gost_kalkan_adapter_missing",
      authority: "nca_authority_adapter_missing",
      warnings,
      signerIin: cert.iin,
      signerBin: cert.bin,
      signerName: cert.commonName,
      certificateSerial: cert.serial,
      certificateIssuer: cert.issuer,
    },
  };
}
