type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let testFetch: FetchLike | null = null;

export function setGreenApiFetchForTests(fn: FetchLike | null) {
  testFetch = fn;
}

function uniqueHosts(instanceId: string, preferred?: string | null) {
  const hosts = [
    String(preferred || "").trim(),
    String(process.env.GREEN_API_HOST || "").trim(),
    `${instanceId}.api.green-api.com`,
    "7107.api.greenapi.com",
  ].filter(Boolean);
  return [...new Set(hosts)];
}

export async function applyGreenApiWebhookUrl(input: {
  instanceId: string;
  apiToken: string;
  webhookUrl: string;
  apiHost?: string | null;
}) {
  const instanceId = String(input.instanceId || "").trim();
  const apiToken = String(input.apiToken || "").trim();
  const webhookUrl = String(input.webhookUrl || "").trim();
  if (!instanceId || !apiToken || !webhookUrl) {
    return { ok: false as const, host: null as string | null, error: "missing_green_api" };
  }
  const fetchImpl = testFetch || fetch;
  let lastError = "green_api_unreachable";
  for (const host of uniqueHosts(instanceId, input.apiHost)) {
    const url = `https://${host}/waInstance${instanceId}/setSettings/${apiToken}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl,
          incomingWebhook: "yes",
          outgoingWebhook: "no",
          outgoingAPIMessageWebhook: "no",
          outgoingMessageWebhook: "no",
          stateWebhook: "yes",
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return { ok: true as const, host, error: null };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "green_api_unreachable";
    }
  }
  return { ok: false as const, host: null as string | null, error: lastError };
}

export async function checkGreenApiWhatsAppNumber(input: {
  instanceId: string;
  apiToken: string;
  phone: string;
  apiHost?: string | null;
}): Promise<{ exists: boolean | null; skipped?: boolean; reason?: string }> {
  const instanceId = String(input.instanceId || "").trim();
  const apiToken = String(input.apiToken || "").trim();
  const digits = String(input.phone || "").replace(/\D/g, "");
  if (!instanceId || !apiToken) {
    return { exists: null, skipped: true, reason: "missing_green_api" };
  }
  if (digits.length < 11 || digits.length > 16) {
    return { exists: false, reason: "Некорректный номер WhatsApp" };
  }
  const fetchImpl = testFetch || fetch;
  let lastReason = "Не удалось проверить, есть ли WhatsApp на номере";
  for (const host of uniqueHosts(instanceId, input.apiHost)) {
    const url = `https://${host}/waInstance${instanceId}/checkWhatsapp/${apiToken}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: Number(digits) }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await response.json().catch(() => null)) as { existsWhatsapp?: boolean } | null;
      if (data?.existsWhatsapp === false) {
        return { exists: false, reason: "Номер не зарегистрирован в WhatsApp" };
      }
      if (data?.existsWhatsapp === true) {
        return { exists: true };
      }
      lastReason = response.ok ? lastReason : `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : lastReason;
    }
  }
  return { exists: null, skipped: true, reason: lastReason };
}
