import { existsSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import type { AuthContext } from "../../lib/types.ts";
import { ApiError } from "../../errors.ts";
import { readEsfConfig, type EsfConfig } from "./EsfConfig.ts";
import { signingReadiness } from "./EsfSignatureService.ts";

export type EsfProbeResult = { reachable: boolean; status?: number };

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function sdkLocalServerDir() {
  const fromEnv = String(process.env.ESF_SDK_DIR || "").trim();
  if (fromEnv) return path.join(fromEnv, "Документация ЭСФ SDK", "sdk", "localserver");
  const home = String(process.env.HOME || "").trim();
  return home ? path.join(home, "Downloads", "esf-sdk-2025", "Документация ЭСФ SDK", "sdk", "localserver") : "";
}

function hostPort(url: string) {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    return { host: parsed.hostname, port };
  } catch {
    return { host: "", port: 0 };
  }
}

export function probeTcp(host: string, port: number, timeoutMs = 4000): Promise<EsfProbeResult> {
  if (!host || !port) return Promise.resolve({ reachable: false });
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ reachable: false });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({ reachable: true });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve({ reachable: false });
    });
  });
}

export async function probeLocalServiceWsdl(localServiceUrl: string, timeoutMs = 3000): Promise<EsfProbeResult> {
  const wsdl = `${String(localServiceUrl || "").replace(/\/$/, "")}/LocalService?wsdl`;
  try {
    const response = await fetch(wsdl, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    return {
      reachable: response.ok && /LocalService|generateSignature/i.test(text),
      status: response.status,
    };
  } catch {
    const parsed = hostPort(localServiceUrl || "http://127.0.0.1:6666");
    return probeTcp(parsed.host || "127.0.0.1", parsed.port || 6666, timeoutMs);
  }
}

export async function buildEsfPreflight(input?: {
  config?: EsfConfig;
  probeLocalService?: () => Promise<EsfProbeResult>;
  probeEsfHost?: () => Promise<EsfProbeResult>;
  pathExists?: (value: string) => boolean;
}) {
  const config = input?.config || readEsfConfig();
  const exists = input?.pathExists || existsSync;
  const signing = signingReadiness(config);
  const signPath = config.signCertificatePath;
  const localService = input?.probeLocalService
    ? await input.probeLocalService()
    : await probeLocalServiceWsdl(config.localServiceUrl);
  const esfTarget = hostPort(config.baseUrl);
  const esfHost = input?.probeEsfHost
    ? await input.probeEsfHost()
    : await probeTcp(esfTarget.host, esfTarget.port);
  const sdkDir = sdkLocalServerDir();
  const localServerJarFound = Boolean(sdkDir && exists(path.join(sdkDir, "esf_local_server.jar")));

  const blockers: string[] = [];
  if (config.provider === "mock") {
    blockers.push("ESF_PROVIDER=mock — это локальная заглушка, не TEST КГД. Для живой отправки уберите mock.");
  }
  if (config.esfEnv === "off") {
    blockers.push("ESF_ENV=off. Для кабинета КГД поставьте ESF_ENV=test.");
  }
  if (config.esfEnv === "prod" && !config.allowProd) {
    blockers.push("ESF_ENV=prod без ESF_ALLOW_PROD — боевой контур закрыт.");
  }
  if (!config.liveSendAllowed) {
    blockers.push("Живая отправка выключена. Нужны ESF_ENV=test и ESF_ALLOW_LIVE_SEND=1. Production не открываем.");
  }
  if (!esfHost.reachable) {
    blockers.push(`Хост ИС ЭСФ недоступен: ${esfTarget.host}:${esfTarget.port}`);
  }

  const legacy: string[] = [];
  if (config.tin || config.iin) {
    legacy.push("ESF_TIN/ESF_IIN больше не идентичность tenant. БИН — из реквизитов, ИИН — из сертификата.");
  }
  if (config.passwordConfigured) {
    legacy.push("ESF_PASSWORD в .env не используется для нового подключения. Пароль кабинета вводится на экране и не сохраняется.");
  }
  if (signPath || config.signCertificatePinConfigured) {
    legacy.push("ESF_SIGN_CERT_PATH/PIN — LEGACY POC. В production SaaS сервер не читает .p12.");
  }
  if (config.provider !== "mock" && !localService.reachable && localServerJarFound) {
    legacy.push("LocalService :6666 не отвечает. Нужен только для DEV POC подписи, не для NCALayer.");
  }

  const ready = config.provider !== "mock" && config.liveSendAllowed && esfHost.reachable;

  return {
    ready,
    nextStep: ready
      ? "Системный контур TEST доступен. Подключение — Интеграции → ИС ЭСФ через NCALayer."
      : blockers[0] || "Проверьте ESF_PROVIDER, ESF_ENV и доступность хоста КГД.",
    blockers,
    legacy,
    provider: config.provider,
    esfEnv: config.esfEnv,
    liveSendAllowed: config.liveSendAllowed,
    legacyPocEnabled: config.legacyPocEnabled,
    session: {
      ready: false,
      tinConfigured: false,
      certificateConfigured: false,
      passwordConfigured: false,
      iinConfigured: false,
      identitySource: "TenantLegalProfile.bin + NCALayer AUTH certificate",
    },
    signing: {
      ready: false,
      code: signing.code,
      certificatePathConfigured: Boolean(signPath),
      certificatePathExists: Boolean(signPath && exists(signPath)),
      pinConfigured: config.signCertificatePinConfigured,
      signCertificatePemConfigured: Boolean(config.signCertificatePem),
      localServiceUrl: `${config.localServiceUrl}/LocalService`,
      legacyServerP12Allowed: config.legacyServerP12Allowed,
    },
    probes: {
      localService,
      esfHost: { ...esfHost, host: esfTarget.host, port: esfTarget.port },
    },
    sdk: {
      localServerJarFound,
    },
  };
}

export async function getEsfPreflight(auth: AuthContext) {
  requireTenant(auth);
  return buildEsfPreflight();
}
