import { config } from "../config.ts";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey?: string;
};

export function fromAddress() {
  return "BasQar <support@bsqr.kz>";
}

async function sendViaResend(message: MailMessage) {
  const key = process.env.RESEND_API_KEY || "";
  if (!key) return { delivered: false as const, failureKind: "permanent" as const, errorCode: "mail_not_configured" };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(message.idempotencyKey ? {"Idempotency-Key":message.idempotencyKey} : {}),
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html || undefined,
    }),
  });
  if (!response.ok) {
    console.error("[mail] resend failed", response.status);
    return { delivered: false as const, failureKind: response.status === 429 ? "retryable" as const : response.status >= 500 || response.status === 408 ? "uncertain" as const : "permanent" as const,
      errorCode: response.status === 429 ? "mail_rate_limited" : response.status >= 500 || response.status === 408 ? "mail_result_unknown" : "mail_rejected" };
  }
  return { delivered: true as const, channel: "resend" as const };
}

/** Minimal mail abstraction. Logs in environments without a provider. Never throws to callers. */
export async function sendMail(message: MailMessage) {
  try {
    const result = await sendViaResend(message);
    if (result.delivered) return result;
    return { ...result, channel: "log" as const };
  } catch (error) {
    console.error("[mail] send failed", error);
  }
  if (config.nodeEnv !== "production") {
    console.info("[mail:log]", message.to, message.subject);
  }
  return { delivered: false as const, channel: "log" as const, failureKind: "uncertain" as const, errorCode: "mail_result_unknown" };
}

export function verificationEmail(to: string, code: string) {
  return {
    to,
    subject: "Код подтверждения BasQar",
    text: `Ваш код подтверждения BasQar: ${code}\n\nКод действует 15 минут. Если вы не регистрировались, проигнорируйте это письмо.`,
    html: `<p>Ваш код подтверждения BasQar: <strong>${code}</strong></p><p>Код действует 15 минут. Если вы не регистрировались, проигнорируйте это письмо.</p>`,
  };
}

export function passwordResetEmail(to: string, code: string) {
  return {
    to,
    subject: "Восстановление пароля BasQar",
    text: `Вы запросили восстановление пароля BasQar.\n\nКод подтверждения:\n\n${code}\n\nКод действует 10 минут.\n\nЕсли Вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.`,
    html: `<p>Вы запросили восстановление пароля BasQar.</p><p>Код подтверждения:</p><p><strong>${code}</strong></p><p>Код действует 10 минут.</p><p>Если Вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.</p>`,
  };
}
