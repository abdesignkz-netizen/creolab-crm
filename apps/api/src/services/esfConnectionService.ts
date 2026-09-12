import { certificateFromSignedAuthTicket, createEsfAuthTicket, createEsfSessionFromSignedTicket } from "../integrations/esf/EsfTicketAuth.ts";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import { normalizeKzTaxId } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { readEsfConfig, sanitizedEsfHost, type EsfConfig } from "../integrations/esf/EsfConfig.ts";
import {
  closeEsfSession,
  createEsfSessionFromPublicCert,
  currentEsfSessionStatus,
} from "../integrations/esf/EsfSessionService.ts";
import { diagnosePublicCertificate, officialEsfFaultCode } from "../integrations/esf/poc/diagnosePublicCertificate.ts";
import { inspectCertificatePem, normalizeCertificatePem, pemFromCms } from "./cmsInspect.ts";
import { can, type AuthContext } from "../lib/types.ts";

export const ESF_CONNECTION_STATUSES = [
  "NOT_CONNECTED",
  "CONNECTING",
  "CONNECTED",
  "SESSION_EXPIRED",
  "REAUTH_REQUIRED",
  "ERROR",
] as const;

export type EsfConnectionStatus = (typeof ESF_CONNECTION_STATUSES)[number];

const FORBIDDEN_KEY_FIELDS = [
  "pin",
  "certificatePin",
  "certificatePath",
  "p12",
  "pkcs12",
  "privateKey",
  "private_key",
  "esfSignCertPin",
  "signCertPin",
];

const REAUTH_MESSAGE =
  "Для продолжения работы с ИС ЭСФ требуется повторная авторизация через NCALayer";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireConnectPermission(auth: AuthContext) {
  if (!can(auth, "manage_integrations") && !can(auth, "send_esf")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для ИС ЭСФ");
  }
}

function rejectPrivateKeyFields(input: Record<string, unknown>) {
  for (const key of FORBIDDEN_KEY_FIELDS) {
    if (input[key] != null && String(input[key]).trim()) {
      throw new ApiError(400, "esf_private_key_forbidden", "ЭЦП, .p12 и PIN нельзя передавать на сервер");
    }
  }
}

export function connectionEnvironment(config = readEsfConfig()) {
  return config.esfEnv === "off" ? "test" : config.esfEnv;
}

export function describeAvrPocReadiness(
  row: {
    status: string;
    sessionId: string | null;
    sessionExpiresAt: Date | null;
    environment?: string | null;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
  } | null,
  config: EsfConfig,
) {
  const reasons: string[] = [];
  if (config.esfEnv !== "test") reasons.push("Контур не TEST");
  if (config.provider !== "live") reasons.push("POC требует реальный TEST SOAP, mock не подходит");
  if (!config.liveSendAllowed) reasons.push("Реальный SOAP выключен: требуется ESF_ALLOW_LIVE_SEND=1");
  if (row && row.environment !== "test") reasons.push("Сессия создана не в TEST");
  if (!row || row.status !== "CONNECTED") reasons.push("Нет CONNECTED сессии");
  if (!row?.sessionId) reasons.push("sessionId отсутствует");
  if (row?.sessionExpiresAt && row.sessionExpiresAt.getTime() <= Date.now()) reasons.push("Сессия истекла");
  if (row?.lastErrorCode === "CERTIFICATE_NOT_VALID" || /CERTIFICATE_NOT_VALID/.test(row?.lastErrorMessage || "")) {
    reasons.push("createSession не принял AUTH-сертификат");
  }
  return {
    ready: reasons.length === 0,
    reasons,
    environment: config.esfEnv === "test" ? "TEST" : config.esfEnv.toUpperCase(),
    endpointHost: sanitizedEsfHost(config.baseUrl),
    sessionStatus: row?.status || "NOT_CONNECTED",
    sessionExpiresAt: row?.sessionExpiresAt?.toISOString() || null,
    sessionActive: Boolean(row && isSessionUsable(row)),
  };
}

function isSessionUsable(row: {
  status: string;
  sessionId: string | null;
  sessionExpiresAt: Date | null;
}) {
  if (!row.sessionId) return false;
  if (row.status !== "CONNECTED") return false;
  if (row.sessionExpiresAt && row.sessionExpiresAt.getTime() <= Date.now()) return false;
  return true;
}

function publicConnection(row: {
  status: string;
  environment: string;
  organizationBin: string | null;
  signerIin: string | null;
  authCertificateSerial: string | null;
  authCertificateValidFrom: Date | null;
  authCertificateValidTo: Date | null;
  lastConnectedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  sessionId: string | null;
  sessionExpiresAt: Date | null;
} | null) {
  const status = (row?.status || "NOT_CONNECTED") as EsfConnectionStatus;
  const sessionActive = Boolean(row && isSessionUsable(row));
  return {
    status,
    environment: row?.environment || null,
    organizationBin: row?.organizationBin || null,
    signerIin: row?.signerIin || null,
    certificateSerial: row?.authCertificateSerial || null,
    certificateValidFrom: row?.authCertificateValidFrom || null,
    certificateValidTo: row?.authCertificateValidTo || null,
    lastConnectedAt: row?.lastConnectedAt || null,
    lastErrorCode: row?.lastErrorCode || null,
    lastErrorMessage: row?.lastErrorMessage || null,
    sessionActive,
    reauthRequired: status === "REAUTH_REQUIRED" || status === "SESSION_EXPIRED",
    reauthMessage: status === "REAUTH_REQUIRED" || status === "SESSION_EXPIRED" ? REAUTH_MESSAGE : null,
  };
}

export async function getEsfConnectionRow(
  prisma: PrismaClient,
  tenantId: string,
  environment: string = connectionEnvironment(),
) {
  return prisma.esfConnection.findUnique({
    where: { tenantId_environment: { tenantId, environment } },
  });
}

export async function getUsableEsfSession(
  prisma: PrismaClient,
  tenantId: string,
  config = readEsfConfig(),
) {
  const environment = connectionEnvironment(config);
  const row = await getEsfConnectionRow(prisma, tenantId, environment);
  if (!row) return null;
  if (row.sessionExpiresAt && row.sessionExpiresAt.getTime() <= Date.now() && row.sessionId) {
    await markEsfReauthRequired(prisma, tenantId, environment, "SESSION_EXPIRED", "Сессия ИС ЭСФ истекла");
    return null;
  }
  if (!isSessionUsable(row)) return null;
  return { sessionId: row.sessionId!, row };
}

export async function markEsfReauthRequired(
  prisma: PrismaClient,
  tenantId: string,
  environment: string,
  code = "REAUTH_REQUIRED",
  message = REAUTH_MESSAGE,
) {
  const existing = await getEsfConnectionRow(prisma, tenantId, environment);
  if (!existing) return null;
  return prisma.esfConnection.update({
    where: { id: existing.id },
    data: {
      status: code === "SESSION_EXPIRED" ? "SESSION_EXPIRED" : "REAUTH_REQUIRED",
      sessionId: null,
      lastErrorCode: code,
      lastErrorMessage: message,
    },
  });
}

export async function getEsfConnection(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  requireConnectPermission(auth);
  const config = readEsfConfig();
  const environment = connectionEnvironment(config);
  const legal = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  let row = await getEsfConnectionRow(prisma, membership.tenantId, environment);
  if (row?.sessionId && row.status === "CONNECTED" && config.provider !== "mock") {
    const live = await currentEsfSessionStatus(row.sessionId, config);
    if (live.status === "CLOSED" || live.status === "NOT_FOUND") {
      row = await markEsfReauthRequired(
        prisma,
        membership.tenantId,
        environment,
        live.status === "CLOSED" ? "SESSION_EXPIRED" : "REAUTH_REQUIRED",
        REAUTH_MESSAGE,
      );
    }
  }
  return {
    connection: publicConnection(row),
    organization: {
      legalName: legal?.legalName || null,
      bin: legal?.bin || null,
    },
    system: {
      provider: config.provider,
      esfEnv: config.esfEnv,
      environmentLabel: config.esfEnv === "test" ? "TEST" : config.esfEnv.toUpperCase(),
      endpointHost: sanitizedEsfHost(config.baseUrl),
      liveSendAllowed: config.liveSendAllowed,
      sessionUrl: config.sessionUrl,
      legacyPocEnabled: config.legacyPocEnabled,
    },
    avrPoc: describeAvrPocReadiness(row, config),
    authCertificate: sanitizeStoredAuthCertificate(row?.authCertificatePem, {
      expectedEnv: config.esfEnv,
      expectedBin: legal?.bin || row?.organizationBin,
      lastFault: row?.lastErrorMessage || "",
    }),
    // A live provider alone does not establish a requirement for cabinet credentials.
    wsseRequired: config.provider !== "mock" && row?.status === "REAUTH_REQUIRED" &&
      row.lastErrorCode === "esf_wsse_required",
    ncalayer: {
      module: "kz.gov.pki.knca.basics",
      method: "sign",
      authExtKeyUsageOid: "1.3.6.1.5.5.7.3.2",
      formats: ["cms", "xml"],
      esfSigner: {
        bundleSymbolicName: "com.osdkz.esf.signer",
        bundleVersion: "1.2",
        service: "com.osdkz.esf.signer.esfSigner",
        signMethod: "signPlainData",
        methods: ["signPlainData", "signPlainDataMap", "auth"],
      },
    },
  };
}

function sanitizeStoredAuthCertificate(
  pem: string | null | undefined,
  options: { expectedEnv?: "test" | "prod" | "local" | "off"; expectedBin?: string | null; lastFault?: string },
) {
  if (!pem) return null;
  try {
    return diagnosePublicCertificate(pem, options);
  } catch {
    return null;
  }
}

function resolveAuthCertificate(input: { authCmsBase64?: string; authCertificatePem?: string }) {
  if (input.authCertificatePem) {
    const pem = normalizeCertificatePem(input.authCertificatePem);
    return { pem, inspected: inspectCertificatePem(pem) };
  }
  if (input.authCmsBase64) {
    const pem = pemFromCms(input.authCmsBase64);
    return { pem, inspected: inspectCertificatePem(pem) };
  }
  throw new ApiError(422, "esf_certificate_required", "Выберите сертификат аутентификации в NCALayer");
}

export async function prepareEsfAuthTicket(prisma: PrismaClient, auth: AuthContext, input: Record<string, unknown>) {
  const membership = requireTenant(auth);
  requireConnectPermission(auth);
  rejectPrivateKeyFields(input);
  const iin = normalizeKzTaxId(String(input.iin || ""));
  if (!iin) throw new ApiError(422, "esf_iin_required", "Укажите ИИН пользователя для входа через ЭЦП");
  const legal = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  if (!normalizeKzTaxId(legal?.bin || null)) throw new ApiError(422, "esf_bin_required", "Сначала укажите БИН организации в реквизитах");
  const config = readEsfConfig();
  if (config.provider !== "live" || config.esfEnv === "off") throw new ApiError(422, "esf_live_required", "Тикет доступен только для подключения к ИС ЭСФ");
  return createEsfAuthTicket(iin, config);
}

export async function connectEsf(
  prisma: PrismaClient,
  auth: AuthContext,
  raw: Record<string, unknown>,
) {
  const membership = requireTenant(auth);
  requireConnectPermission(auth);
  rejectPrivateKeyFields(raw);
  const config = readEsfConfig();
  if (config.esfEnv === "off") {
    throw new ApiError(422, "esf_env_off", "Для ИС ЭСФ нужен ESF_ENV=test или ESF_ENV=prod");
  }
  if (config.esfEnv === "prod" && !config.allowProd) {
    throw new ApiError(422, "esf_prod_closed", "Боевой контур ИС ЭСФ закрыт");
  }

  const legal = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  const organizationBin = normalizeKzTaxId(legal?.bin || null);
  if (!organizationBin) {
    throw new ApiError(422, "esf_bin_required", "Сначала укажите БИН организации в реквизитах");
  }

  let certificate: { pem: string; inspected: ReturnType<typeof inspectCertificatePem> };
  try {
    certificate = resolveAuthCertificate({
      authCmsBase64: raw.authCmsBase64 ? String(raw.authCmsBase64) : undefined,
      authCertificatePem: raw.signedAuthTicket ? certificateFromSignedAuthTicket(String(raw.signedAuthTicket)) : raw.authCertificatePem ? String(raw.authCertificatePem) : undefined,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "CERTIFICATE_NOT_SELECTED", "Не удалось прочитать публичный сертификат NCALayer");
  }

  if (certificate.inspected.validTo && certificate.inspected.validTo.getTime() <= Date.now()) {
    throw new ApiError(422, "CERTIFICATE_EXPIRED", "Срок действия сертификата ЭЦП истёк");
  }
  if (certificate.inspected.bin && certificate.inspected.bin !== organizationBin) {
    throw new ApiError(422, "esf_bin_mismatch", "БИН в сертификате не совпадает с реквизитами организации");
  }

  const signerIin =
    normalizeKzTaxId(certificate.inspected.iin) ||
    normalizeKzTaxId(raw.cabinetUsername ? String(raw.cabinetUsername) : null) ||
    normalizeKzTaxId(legal?.iin || null);
  const cabinetUsername = String(raw.cabinetUsername || signerIin || "").trim();
  const cabinetPassword = raw.cabinetPassword == null ? "" : String(raw.cabinetPassword);

  const environment = connectionEnvironment(config);
  const existing = await getEsfConnectionRow(prisma, membership.tenantId, environment);
  const connecting = existing
    ? await prisma.esfConnection.update({
        where: { id: existing.id },
        data: { status: "CONNECTING", lastErrorCode: null, lastErrorMessage: null },
      })
    : await prisma.esfConnection.create({
        data: {
          id: randomUUID(),
          tenantId: membership.tenantId,
          environment,
          status: "CONNECTING",
        },
      });

  try {
    const session = raw.signedAuthTicket
      ? await createEsfSessionFromSignedTicket(organizationBin, String(raw.signedAuthTicket), config)
      : await createEsfSessionFromPublicCert(
      {
        tin: organizationBin,
        x509Certificate: certificate.pem,
        wsseUsername: cabinetPassword ? cabinetUsername || undefined : undefined,
        wssePassword: cabinetPassword || undefined,
      },
      config,
    );

    if (!session.ok) {
      const officialFault = session.officialFault || officialEsfFaultCode(session.message);
      const status = session.code === "esf_wsse_required" ? "REAUTH_REQUIRED" : "ERROR";
      const saved = await prisma.esfConnection.update({
        where: { id: connecting.id },
        data: {
          status,
          sessionId: null,
          organizationBin,
          signerIin,
          authCertificatePem: certificate.pem,
          authCertificateSerial: certificate.inspected.serial || null,
          authCertificateValidFrom: certificate.inspected.validFrom,
          authCertificateValidTo: certificate.inspected.validTo,
          lastErrorCode: officialFault || session.code,
          lastErrorMessage:
            session.code === "esf_wsse_required"
              ? `${cabinetPassword
                  ? "ИС ЭСФ отклонила авторизацию с переданными данными кабинета."
                  : "ИС ЭСФ требует авторизацию кабинета. Это не PIN ЭЦП."} ${session.message}`
              : session.message,
        },
      });
      return {
        connection: publicConnection(saved),
        organization: { legalName: legal?.legalName || null, bin: organizationBin },
        authCertificate: sanitizeStoredAuthCertificate(certificate.pem, {
          expectedEnv: config.esfEnv,
          expectedBin: organizationBin,
          lastFault: session.message,
        }),
        wsseRequired: Boolean(session.wsseRequired),
        ok: false as const,
        code: officialFault || session.code,
        message: saved.lastErrorMessage,
      };
    }

    const saved = await prisma.esfConnection.update({
      where: { id: connecting.id },
      data: {
        status: "CONNECTED",
        sessionId: session.sessionId,
        sessionCreatedAt: new Date(),
        sessionExpiresAt: null,
        organizationBin,
        signerIin,
        authCertificatePem: certificate.pem,
        authCertificateSerial: certificate.inspected.serial || null,
        authCertificateValidFrom: certificate.inspected.validFrom,
        authCertificateValidTo: certificate.inspected.validTo,
        lastConnectedAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    if (!legal?.esfIntegrationEnabled) {
      await prisma.tenantLegalProfile.upsert({
        where: { tenantId: membership.tenantId },
        update: { esfIntegrationEnabled: true },
        create: { tenantId: membership.tenantId, bin: organizationBin, esfIntegrationEnabled: true },
      });
    }

    await prisma.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        actorUserId: auth.user.id,
        action: "esf.connection.connect",
        entityType: "esf_connection",
        entityId: saved.id,
        changesJson: {
          environment,
          organizationBin,
          signerIin,
          certificateSerial: saved.authCertificateSerial,
        },
      },
    });

    return {
      connection: publicConnection(saved),
      organization: { legalName: legal?.legalName || null, bin: organizationBin },
      authCertificate: sanitizeStoredAuthCertificate(certificate.pem, {
        expectedEnv: config.esfEnv,
        expectedBin: organizationBin,
      }),
      wsseRequired: false,
      ok: true as const,
      code: "ok",
      message: "",
    };
  } catch (error) {
    const saved = await prisma.esfConnection.update({
      where: { id: connecting.id },
      data: {
        status: "ERROR",
        sessionId: null,
        lastErrorCode: "ERROR",
        lastErrorMessage: error instanceof Error ? error.message : "Не удалось подключить ИС ЭСФ",
      },
    });
    return {
      connection: publicConnection(saved),
      organization: { legalName: legal?.legalName || null, bin: organizationBin },
      wsseRequired: false,
      ok: false as const,
      code: "ERROR",
      message: saved.lastErrorMessage,
    };
  } finally {
    raw.cabinetPassword = "";
    raw.signedAuthTicket = "";
  }
}

export async function disconnectEsf(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  requireConnectPermission(auth);
  const config = readEsfConfig();
  const environment = connectionEnvironment(config);
  const existing = await getEsfConnectionRow(prisma, membership.tenantId, environment);
  if (existing?.sessionId) {
    await closeEsfSession(existing.sessionId, config);
  }
  const saved = existing
    ? await prisma.esfConnection.update({
        where: { id: existing.id },
        data: {
          status: "NOT_CONNECTED",
          sessionId: null,
          sessionCreatedAt: null,
          sessionExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      })
    : null;
  if (saved) {
    await prisma.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        actorUserId: auth.user.id,
        action: "esf.connection.disconnect",
        entityType: "esf_connection",
        entityId: saved.id,
        changesJson: { environment },
      },
    });
  }
  const legal = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  return {
    connection: publicConnection(saved),
    organization: { legalName: legal?.legalName || null, bin: legal?.bin || null },
  };
}

export async function refreshEsfConnectionStatus(
  prisma: PrismaClient,
  tenantId: string,
  config: EsfConfig = readEsfConfig(),
) {
  const environment = connectionEnvironment(config);
  const row = await getEsfConnectionRow(prisma, tenantId, environment);
  if (!row?.sessionId) return row;
  const live = await currentEsfSessionStatus(row.sessionId, config);
  if (live.status === "CLOSED") {
    return markEsfReauthRequired(prisma, tenantId, environment, "SESSION_EXPIRED", REAUTH_MESSAGE);
  }
  if (live.status === "NOT_FOUND") {
    return markEsfReauthRequired(prisma, tenantId, environment, "REAUTH_REQUIRED", REAUTH_MESSAGE);
  }
  return row;
}
