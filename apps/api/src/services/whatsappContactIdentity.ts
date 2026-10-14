import type { Prisma } from "@creolab/db";

export function whatsappPhoneJid(value?: string | null) {
  const phone = value?.match(/^(\d{7,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/)?.[1];
  return phone ? `${phone}@s.whatsapp.net` : null;
}

export function whatsappLid(value?: string | null) {
  const id = value?.match(/^(\d+)(?::\d+)?@lid$/)?.[1];
  return id ? `${id}@lid` : null;
}

export async function storeWhatsAppPhone(tx: Prisma.TransactionClient, tenantId: string, contactId: string, phone: string) {
  if (!/^\d{7,15}$/.test(phone)) return;
  // Incoming messages and contact updates may arrive together. Serialize the
  // check/insert, and retain the owner's primary/manual contact methods.
  await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${contactId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const methods = await tx.contactMethod.findMany({ where: { tenantId, contactId, type: { in: ["phone", "whatsapp"] } } });
  const exists = methods.some(method => [method.rawValue, method.normalizedValue].some(value =>
    /^[+\d\s().-]+$/.test(value) && value.replace(/\D/g, "") === phone));
  if (!exists) await tx.contactMethod.create({ data: { tenantId, contactId, type: "phone", rawValue: `+${phone}`, normalizedValue: phone, source: "whatsapp", confirmed: false } });
}

// Apply only identities supplied by WhatsApp, scoped to this connection. Never
// import an address book or merge separate CRM contacts because of a mapping.
export async function syncWhatsAppContactPhone(tx: Prisma.TransactionClient, integrationId: string, input: { lid?: string | null; pn?: string | null }) {
  const pn = whatsappPhoneJid(input.pn), lid = whatsappLid(input.lid);
  if (!pn || input.lid && !lid) return;
  const connection = await tx.channelConnection.findFirst({ where: {
    integrationId, channelType: "whatsapp", integration: { type: "whatsapp_qr", status: "active", tenant: { status: "active" } },
  } });
  if (!connection) return;
  const { tenantId } = connection;
  const externalIds = lid ? [lid, pn] : [pn];
  const scope = { tenantId, connectionId: connection.id, type: "whatsapp" };
  const identities = await tx.externalIdentity.findMany({ where: { ...scope, externalId: { in: externalIds } } });
  const contactIds = [...new Set(identities.map(identity => identity.contactId))];
  if (contactIds.length !== 1) return;
  const contactId = contactIds[0]!;
  for (const externalId of externalIds) {
    const identity = await tx.externalIdentity.upsert({
      where: { tenantId_type_externalId_connectionId: { ...scope, externalId } },
      create: { ...scope, integrationId, contactId, externalId }, update: {},
    });
    if (identity.contactId !== contactId) return;
  }
  await storeWhatsAppPhone(tx, tenantId, contactId, pn.split("@")[0]!);
}
