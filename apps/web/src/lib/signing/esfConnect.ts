import { api } from "../api";
import { createNcalayerClient, NcalayerError } from "./ncalayerClient";

export class EsfCabinetAuthError extends Error {
  code: string;
  wsseRequired: boolean;
  body?: unknown;
  constructor(message: string, code: string, wsseRequired = false, body?: unknown) {
    super(message);
    this.name = "EsfCabinetAuthError";
    this.code = code;
    this.wsseRequired = wsseRequired;
    this.body = body;
  }
}

function digitsIin(value?: string | null) {
  return String(value || "").replace(/\D/g, "");
}

function isWsseRequired(err: any) {
  return Boolean(
    err?.wsseRequired ||
      err?.body?.wsseRequired ||
      err?.code === "esf_wsse_required" ||
      err?.body?.code === "esf_wsse_required",
  );
}

/** Existing AUTH-ticket flow, shared by integration settings and the document card. */
export async function connectEsfAuthTicket(iin: string, cabinetPassword?: string) {
  if (!/^\d{12}$/.test(iin.trim())) throw new Error("Укажите ИИН пользователя — 12 цифр");
  const client = createNcalayerClient();
  try {
    if (!(await client.isAvailable())) {
      throw new NcalayerError("NCALAYER_NOT_RUNNING", "Запустите NCALayer и повторите подключение");
    }
    const ticket = (await api.esfAuthTicket(iin.trim())) as { authTicketXml: string };
    const signedAuthTicket = await client.signXml(ticket.authTicketXml, { extKeyUsageOids: [] });
    return await api.esfConnect({
      signedAuthTicket,
      cabinetUsername: iin.trim(),
      cabinetPassword: cabinetPassword || undefined,
    });
  } finally {
    client.disconnect();
  }
}

/** Open or reuse a cabinet session before signing the document itself. */
export async function ensureEsfCabinetSession(opts: { iin?: string; cabinetPassword?: string } = {}) {
  const current = (await api.esfConnection()) as any;
  if (current.system?.esfEnv === "off") {
    throw new EsfCabinetAuthError(
      "Подключение к ИС ЭСФ выключено на сервере. Для отправки АВР нужно включить режим ИС ЭСФ в настройках сервера.",
      "esf_env_off",
    );
  }
  if (current.connection?.sessionActive) return current;

  try {
    if (current.system?.provider === "live") {
      if (current.wsseRequired && !String(opts.cabinetPassword || "").trim()) {
        throw new EsfCabinetAuthError(
          "Портал запросил пароль кабинета ИС ЭСФ. Введите его ниже и снова нажмите «Подписать и отправить». Это не PIN ЭЦП.",
          "esf_wsse_required",
          true,
          current,
        );
      }
      const iin = digitsIin(opts.iin || current.connection?.signerIin);
      if (!/^\d{12}$/.test(iin)) {
        throw new EsfCabinetAuthError("Укажите ИИН пользователя для входа в ИС ЭСФ — 12 цифр.", "esf_iin_required");
      }
      await connectEsfAuthTicket(iin, opts.cabinetPassword);
    } else {
      const basics = createNcalayerClient();
      try {
        if (!(await basics.isAvailable())) {
          throw new NcalayerError("NCALAYER_NOT_RUNNING", "Запустите NCALayer и повторите отправку");
        }
        const cms = await basics.selectAuthCertificate();
        await api.esfConnect({
          authCmsBase64: cms,
          cabinetUsername: opts.iin || undefined,
          cabinetPassword: opts.cabinetPassword || undefined,
        });
      } finally {
        basics.disconnect();
      }
    }
  } catch (err: any) {
    if (err instanceof EsfCabinetAuthError || err instanceof NcalayerError) throw err;
    throw new EsfCabinetAuthError(
      err?.body?.message || err?.message || "Авторизация ИС ЭСФ не завершена",
      err?.body?.code || err?.code || "REAUTH_REQUIRED",
      isWsseRequired(err),
      err?.body,
    );
  }

  const updated = (await api.esfConnection()) as any;
  if (!updated.connection?.sessionActive) {
    throw new EsfCabinetAuthError(
      updated.connection?.lastErrorMessage || "Авторизация ИС ЭСФ не завершена",
      updated.code || "REAUTH_REQUIRED",
      Boolean(updated.wsseRequired),
      updated,
    );
  }
  return updated;
}
