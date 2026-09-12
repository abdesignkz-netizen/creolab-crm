/**
 * DEV POC only. Calls official SessionService.createSession and optional LocalService.
 * Does not print PEM, passwords, PIN, sessionId, or signature bodies.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEsfConfig } from "../EsfConfig.ts";
import { createEsfSessionFromPublicCert } from "../EsfSessionService.ts";
import { signingReadiness } from "../EsfSignatureService.ts";
import {
  buildGenerateInvoiceSignatureEnvelope,
  parseInvoiceSignature,
  parseSoapFault,
  postSoap,
} from "../EsfSoap.ts";
import { analyzeEsfSignature } from "./analyzeEsfSignature.ts";

function officialInvoiceBody() {
  const file = path.resolve(
    process.cwd().endsWith("apps/api")
      ? "src/integrations/esf/schemas/One InvoiceV2.xml"
      : "apps/api/src/integrations/esf/schemas/One InvoiceV2.xml",
  );
  const xml = readFileSync(file, "utf8");
  const start = xml.indexOf("<v2:invoice");
  const end = xml.indexOf("</v2:invoice>");
  return start >= 0 && end > start ? xml.slice(start, end + "</v2:invoice>".length) : xml;
}

function redactFault(message: string) {
  return String(message || "")
    .replace(/-----BEGIN[\s\S]+?-----END [^-]+-----/g, "[pem]")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[b64]")
    .slice(0, 240);
}

async function probeCreateSession(label: string, input: {
  tin: string;
  x509Certificate: string;
  wsseUsername?: string;
  wssePassword?: string;
}) {
  const started = Date.now();
  const result = await createEsfSessionFromPublicCert(input);
  return {
    label,
    ok: result.ok,
    code: result.code,
    hasSessionId: Boolean(result.sessionId),
    wsseSent: Boolean(input.wssePassword),
    wsseRequired: "wsseRequired" in result ? Boolean(result.wsseRequired) : false,
    message: redactFault(result.message),
    ms: Date.now() - started,
  };
}

async function main() {
  const config = readEsfConfig();
  const outDir = path.resolve(process.cwd().endsWith("apps/api") ? "data/esf-poc" : "apps/api/data/esf-poc");
  mkdirSync(outDir, { recursive: true });

  const report: Record<string, unknown> = {
    at: new Date().toISOString(),
    system: {
      provider: config.provider,
      esfEnv: config.esfEnv,
      sessionUrl: config.sessionUrl,
      liveSendAllowed: config.liveSendAllowed,
      legacyServerP12Allowed: config.legacyServerP12Allowed,
      hasAuthPem: Boolean(config.authCertificatePem),
      hasTinEnv: Boolean(config.tin),
      hasPasswordEnv: config.passwordConfigured,
      hasSignPath: Boolean(config.signCertificatePath),
      hasSignPin: config.signCertificatePinConfigured,
    },
    official: {
      sessionService: "createSession(tin, x509Certificate)",
      soapUiAlwaysHasWsseUsernameToken: true,
      createSessionSignedInCurrentWsdl: false,
      ncalayerBasicsMethod: "sign",
      ncalayerFormats: ["cms", "xml"],
    },
    createSession: [] as unknown[],
    wsseDecision: "inconclusive",
    legacySignature: null as unknown,
    ncalayerSend: "not_run_interactive_ncalayer_required",
    safeToDeleteLegacy: [],
  };

  if (config.provider === "live" && config.authCertificatePem && config.tin) {
    const password = config.passwordConfigured ? String(process.env.ESF_PASSWORD || "") : "";
    try {
      report.createSession = [
        await probeCreateSession("without_wsse", {
          tin: config.tin,
          x509Certificate: config.authCertificatePem,
        }),
        await probeCreateSession("with_wsse", {
          tin: config.tin,
          x509Certificate: config.authCertificatePem,
          wsseUsername: config.iin || undefined,
          wssePassword: password || undefined,
        }),
      ];
    } catch (error) {
      report.createSession = [
        {
          skipped: false,
          ok: false,
          code: "network_error",
          message: error instanceof Error ? error.message : "createSession network error",
        },
      ];
    }
    const rows = report.createSession as Array<{ ok: boolean; wsseSent: boolean; wsseRequired: boolean; code: string }>;
    const without = rows.find((row) => !row.wsseSent);
    const withWsse = rows.find((row) => row.wsseSent);
    if (without?.ok) report.wsseDecision = "not_required";
    else if (withWsse?.ok && !without?.ok) report.wsseDecision = "required";
    else if (!without?.ok && withWsse && without?.code !== withWsse.code) report.wsseDecision = "required";
    else if (without?.wsseRequired) report.wsseDecision = "required";
    else report.wsseDecision = "inconclusive_use_soapui_default_required";
  } else {
    report.createSession = [{ skipped: true, reason: "no_live_public_cert_or_not_live_provider" }];
    report.wsseDecision = "inconclusive_use_soapui_default_required";
  }

  const signing = signingReadiness(config);
  const pin = String(process.env.ESF_SIGN_CERT_PIN || "");
  if (
    config.signCertificatePath &&
    pin &&
    String(process.env.NODE_ENV || "") !== "production"
  ) {
    try {
      const envelope = buildGenerateInvoiceSignatureEnvelope({
        invoiceBody: officialInvoiceBody(),
        certificatePath: config.signCertificatePath,
        certificatePin: pin,
      });
      const response = await postSoap(`${config.localServiceUrl}/LocalService`, envelope);
      const fault = parseSoapFault(response.text);
      const signature = parseInvoiceSignature(response.text);
      const analysis = analyzeEsfSignature(signature);
      if (signature) writeFileSync(path.join(outDir, "legacy-signature.txt"), signature, "utf8");
      report.legacySignature = {
        ok: Boolean(signature),
        code: signature ? "signed" : "esf_localserver_failed",
        message: signature
          ? "written_to_esf-poc/legacy-signature.txt"
          : redactFault(fault?.description || fault?.faultstring || "no signature"),
        analysis,
      };
    } catch (error) {
      const cause = error instanceof Error && "cause" in error ? String((error as { cause?: unknown }).cause || "") : "";
      report.legacySignature = {
        ok: false,
        skipped: false,
        signingCode: signing.code,
        message: [error instanceof Error ? error.message : "LocalService unreachable", cause].filter(Boolean).join(" "),
      };
    }
  } else {
    report.legacySignature = {
      ok: false,
      skipped: true,
      signingCode: signing.code,
      message: signing.message,
    };
  }

  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ ok: true, reportFile: path.join(outDir, "report.json"), wsseDecision: report.wsseDecision }, null, 2)}\n`);
}

void main();
