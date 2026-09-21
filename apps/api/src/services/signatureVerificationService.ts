import { inspectCms, type CmsInspection } from "./cmsInspect.ts";
import { verifyCmsWithKalkan, type KalkanAuthorityStatus, type KalkanCryptoStatus } from "./kalkanCmsVerifyClient.ts";

export type SignatureVerification = {
  status: "PARSED" | "VERIFIED" | "FAILED";
  cryptoStatus: KalkanCryptoStatus;
  authorityStatus: KalkanAuthorityStatus;
  inspection: CmsInspection | null;
  details: Record<string, unknown>;
};

function failed(
  details: Record<string, unknown>,
  inspection: CmsInspection | null = null,
  cryptoStatus: KalkanCryptoStatus = "UNAVAILABLE",
  authorityStatus: KalkanAuthorityStatus = "UNCHECKED",
): SignatureVerification {
  return { status: "FAILED", cryptoStatus, authorityStatus, inspection, details };
}

/** Серверная проверка CMS. GOST НУЦ — только официальный Kalkan (sidecar), без ключа на сервере. */
export async function verifyDocumentSignature(input: {
  cmsBase64: string;
  documentHash: string;
  documentBytes?: Buffer;
  expectedBin?: string | null;
}): Promise<SignatureVerification> {
  let inspection: CmsInspection;
  try {
    inspection = inspectCms(input.cmsBase64);
  } catch {
    return failed({ error: "cms_parse_failed" });
  }
  const cert = inspection.primary;
  if (!cert) return failed({ error: "certificate_missing" }, inspection);
  const now = new Date();
  if (cert.validFrom && cert.validFrom > now) {
    return failed({ error: "certificate_not_yet_valid" }, inspection);
  }
  if (cert.validTo && cert.validTo < now) {
    return failed({ error: "certificate_expired" }, inspection);
  }
  if (!cert.iin) return failed({ error: "signer_iin_missing" }, inspection);
  const warnings: string[] = [];
  if (input.expectedBin && cert.bin && cert.bin !== input.expectedBin) {
    return failed(
      { error: "bin_mismatch", expectedBin: input.expectedBin, certificateBin: cert.bin },
      inspection,
    );
  }
  if (input.expectedBin && !cert.bin) warnings.push("certificate_bin_absent");

  const kalkan = input.documentBytes
    ? await verifyCmsWithKalkan({ cmsBase64: input.cmsBase64, documentBytes: input.documentBytes })
    : { skipped: true, cryptoStatus: "UNAVAILABLE" as const, authorityStatus: "UNCHECKED" as const, error: "gost_kalkan_adapter_missing" };

  const authorityDetail =
    kalkan.authorityStatus === "UNCHECKED" ? "nca_authority_adapter_missing" : kalkan.authorityStatus;

  if (!kalkan.skipped && kalkan.cryptoStatus !== "VERIFIED") {
    return failed(
      {
        error: kalkan.error || "cms_verify_failed",
        documentHash: input.documentHash,
        crypto: kalkan.error || "cms_verify_failed",
        authority: authorityDetail,
        warnings,
      },
      inspection,
      kalkan.cryptoStatus,
      kalkan.authorityStatus,
    );
  }

  if (!kalkan.skipped && kalkan.authorityStatus === "REVOKED") {
    return failed(
      {
        error: "certificate_revoked",
        documentHash: input.documentHash,
        crypto: "kalkan_cms_verified",
        authority: "REVOKED",
        warnings,
      },
      inspection,
      "VERIFIED",
      "REVOKED",
    );
  }

  const verified = kalkan.cryptoStatus === "VERIFIED";
  return {
    status: verified ? "VERIFIED" : "PARSED",
    cryptoStatus: kalkan.cryptoStatus,
    authorityStatus: kalkan.authorityStatus,
    inspection,
    details: {
      documentHash: input.documentHash,
      crypto: verified ? "kalkan_cms_verified" : kalkan.error || "gost_kalkan_adapter_missing",
      authority: authorityDetail,
      warnings,
      signerIin: cert.iin,
      signerBin: cert.bin,
      signerName: cert.commonName,
      certificateSerial: cert.serial,
      certificateIssuer: cert.issuer,
    },
  };
}
