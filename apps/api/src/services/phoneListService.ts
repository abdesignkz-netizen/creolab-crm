import { validateClientPhone } from "@creolab/contracts";
import type { PrismaClient } from "@creolab/db";

export type PhoneListItem = {
  raw: string;
  status: "ok_existing" | "ok_new" | "invalid" | "duplicate";
  phoneRaw?: string;
  phoneNormalized?: string;
  e164?: string;
  contactId?: string | null;
  displayName?: string | null;
  interest?: string | null;
  companyName?: string | null;
  reason?: string;
};

function splitPhoneBlob(text: string): string[] {
  const chunks = text
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const chunk of chunks) {
    const plusCount = (chunk.match(/\+/g) || []).length;
    if (plusCount > 1) {
      tokens.push(
        ...chunk
          .split(/(?=\+)/)
          .map((part) => part.trim())
          .filter(Boolean),
      );
      continue;
    }
    // Space-separated bare numbers like "87071234567 87071112233"
    const bareGroups = chunk.match(/(?:\+?\d[\d\s\-()]{6,}\d)/g);
    if (bareGroups && bareGroups.length > 1) {
      tokens.push(...bareGroups.map((g) => g.replace(/\s+/g, " ").trim()));
      continue;
    }
    if (chunk.includes("+") || /\d/.test(chunk)) tokens.push(chunk.replace(/\s+/g, " ").trim());
  }
  return tokens;
}

export function parsePhoneListText(text: string, defaultRegion = "KZ") {
  const tokens = splitPhoneBlob(text);
  const seen = new Set<string>();
  const items: PhoneListItem[] = [];

  for (const raw of tokens) {
    const validated = validateClientPhone(raw, defaultRegion);
    if (!validated.ok) {
      items.push({ raw, status: "invalid", reason: validated.message, phoneRaw: raw });
      continue;
    }
    if (seen.has(validated.normalized)) {
      items.push({
        raw,
        status: "duplicate",
        phoneRaw: validated.raw,
        phoneNormalized: validated.normalized,
        e164: validated.e164,
        reason: "Дубликат",
      });
      continue;
    }
    seen.add(validated.normalized);
    items.push({
      raw,
      status: "ok_new",
      phoneRaw: validated.raw,
      phoneNormalized: validated.normalized,
      e164: validated.e164,
    });
  }

  return items;
}

export async function enrichPhoneList(
  prisma: PrismaClient,
  tenantId: string,
  items: PhoneListItem[],
): Promise<{
  items: PhoneListItem[];
  summary: {
    total: number;
    valid: number;
    existing: number;
    neu: number;
    invalid: number;
    duplicates: number;
  };
}> {
  const normalized = items.map((item) => item.phoneNormalized).filter(Boolean) as string[];
  const methods = normalized.length
    ? await prisma.contactMethod.findMany({
        where: { tenantId, type: "phone", normalizedValue: { in: normalized } },
        include: {
          contact: {
            include: {
              inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 1 },
            },
          },
        },
      })
    : [];
  const byNorm = new Map(methods.map((m) => [m.normalizedValue, m]));

  const enriched = items.map((item) => {
    if (item.status !== "ok_new" || !item.phoneNormalized) return item;
    const method = byNorm.get(item.phoneNormalized);
    if (!method) return item;
    const inquiry = method.contact.inquiries[0];
    return {
      ...item,
      status: "ok_existing" as const,
      contactId: method.contactId,
      displayName: method.contact.name || [method.contact.firstName, method.contact.lastName].filter(Boolean).join(" ") || null,
      companyName: method.contact.companyName,
      interest: inquiry?.service || inquiry?.subject || null,
      phoneRaw: method.rawValue || item.phoneRaw,
    };
  });

  return {
    items: enriched,
    summary: {
      total: enriched.length,
      valid: enriched.filter((i) => i.status === "ok_existing" || i.status === "ok_new").length,
      existing: enriched.filter((i) => i.status === "ok_existing").length,
      neu: enriched.filter((i) => i.status === "ok_new").length,
      invalid: enriched.filter((i) => i.status === "invalid").length,
      duplicates: enriched.filter((i) => i.status === "duplicate").length,
    },
  };
}

export async function parseAndMatchPhoneList(prisma: PrismaClient, tenantId: string, text: string, defaultRegion = "KZ") {
  const parsed = parsePhoneListText(text, defaultRegion);
  return enrichPhoneList(prisma, tenantId, parsed);
}
