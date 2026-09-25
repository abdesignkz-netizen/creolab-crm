import { config } from "../config.ts";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export function fromAddress() {
  return "BasQar <support@bsqr.kz>";
}

async function sendViaResend(message: MailMessage) {
  const key = process.env.RESEND_API_KEY || "";
  if (!key) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
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
    const body = await response.text().catch(() => "");
    console.error("[mail] resend failed", response.status, body);
    return false;
  }
  return true;
}

/** Minimal mail abstraction. Logs in environments without a provider. Never throws to callers. */
export async function sendMail(message: MailMessage) {
  try {
    if (await sendViaResend(message)) return { delivered: true as const, channel: "resend" as const };
  } catch (error) {
    console.error("[mail] send failed", error);
  }
  if (config.nodeEnv !== "production") {
    console.info("[mail:log]", message.to, message.subject);
  }
  return { delivered: false as const, channel: "log" as const };
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
