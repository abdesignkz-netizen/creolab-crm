import { createHmac, timingSafeEqual } from "node:crypto";

export type AdapterCapability =
  | "receive_inquiries"
  | "receive_messages"
  | "send_text"
  | "send_media"
  | "reply_to_message"
  | "delivery_receipts"
  | "read_receipts"
  | "history_sync"
  | "requires_template_outside_window";

export type NeutralEvent = {
  event_id: string;
  tenant_id: string;
  integration_id: string;
  channel_connection_id?: string | null;
  type:
    | "message.received"
    | "message.sent_external"
    | "message.status_changed"
    | "inquiry.received"
    | "connection.state_changed";
  occurred_at: string;
  received_at: string;
  external_id?: string | null;
  normalized: Record<string, unknown>;
  raw_ref: string;
};

export function formCapabilities(): AdapterCapability[] {
  return ["receive_inquiries"];
}

export function webhookCapabilities(): AdapterCapability[] {
  return ["receive_inquiries"];
}

export function whatsappSellerCapabilities(): AdapterCapability[] {
  return [
    "receive_messages",
    "send_text",
    "send_media",
    "delivery_receipts",
    "history_sync",
  ];
}

export function verifyHmacSha256(rawBody: Buffer, secret: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signature.replace(/^sha256=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function canSendFreeform(capabilities: string[], lastClientAt?: Date | null): {
  allowed: boolean;
  reason?: string;
} {
  if (capabilities.includes("requires_template_outside_window")) {
    if (!lastClientAt) {
      return { allowed: false, reason: "outside_window" };
    }
    const age = Date.now() - lastClientAt.getTime();
    if (age > 24 * 60 * 60 * 1000) {
      return { allowed: false, reason: "outside_window" };
    }
  }
  if (!capabilities.includes("send_text")) {
    return { allowed: false, reason: "capability_missing" };
  }
  return { allowed: true };
}

export type SellerLead = {
  leadId: string;
  clientPhone: string | null;
  clientName?: string | null;
  aiMode?: string | null;
  status?: string | null;
  lastClientMessage?: string | null;
  lastAIMessage?: string | null;
  conversationHistory?: Array<{ role: string; content: string; at?: string }>;
  rawChatId?: string | null;
};

export class WhatsAppSellerBridge {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  enabled() {
    return Boolean(this.baseUrl && this.secret);
  }

  private async request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const { timeoutMs, ...fetchInit } = init || {};
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...fetchInit,
      headers: {
        Authorization: `Bearer ${this.secret}`,
        "Content-Type": "application/json",
        ...(fetchInit.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs ?? 15000),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      const statusHint =
        response.status === 413
          ? "Файл слишком большой для WhatsApp-бота (увеличьте лимит JSON на стороне бота)."
          : null;
      throw new Error(data.error || statusHint || `Seller bridge HTTP ${response.status}`);
    }
    return data;
  }

  health() {
    return this.request<{
      ok: boolean;
      sender: string;
      leadCount?: number;
      storePathKind?: "persistent" | "ephemeral" | string;
    }>("/internal/crm/health");
  }

  listLeads() {
    return this.request<{ leads: SellerLead[] }>("/internal/crm/leads");
  }

  ensureLead(phone: string, name?: string | null) {
    return this.request<{ lead: SellerLead }>("/internal/crm/leads/ensure", {
      method: "POST",
      body: JSON.stringify({ phone, name: name || undefined }),
    });
  }

  setMode(leadId: string, mode: "AUTO" | "HUMAN" | "PAUSED") {
    return this.request(`/internal/crm/leads/${encodeURIComponent(leadId)}/mode`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
  }

  sendText(leadId: string, text: string, idempotencyKey: string) {
    return this.request(`/internal/crm/leads/${encodeURIComponent(leadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, idempotencyKey }),
    });
  }

  sendFile(
    leadId: string,
    input: {
      fileName: string;
      mimeType?: string;
      caption?: string;
      contentBase64?: string;
      fileUrl?: string;
      idempotencyKey?: string;
    },
  ) {
    // File upload via Green API: bot allows ~100s; CRM must wait longer to receive the error body.
    return this.request<{ ok: boolean; idMessage?: string | null; sender?: string }>(
      `/internal/crm/leads/${encodeURIComponent(leadId)}/files`,
      {
        method: "POST",
        body: JSON.stringify(input),
        timeoutMs: Number(process.env.WHATSAPP_FILE_BRIDGE_TIMEOUT_MS || 120000),
      },
    );
  }

  addInstruction(leadId: string, text: string) {
    return this.request(`/internal/crm/leads/${encodeURIComponent(leadId)}/instruction`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }
}
