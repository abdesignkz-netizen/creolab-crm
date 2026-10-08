import type { Prisma, PrismaClient } from "@creolab/db";
import { z } from "zod";
import { loadImage } from "@napi-rs/canvas";
import { renderSubscriptionInvoice } from "./invoicePdf.ts";
import { billingError } from "./config.ts";
import { writeAudit } from "../../lib/audit.ts";
import { requirePlatformAdmin } from "../../lib/access.ts";
import type { AuthContext } from "../../lib/types.ts";

type DB = PrismaClient | Prisma.TransactionClient;
// BasQar subscription is a computer service (NB RK payment classifier, code 851).
// https://adilet.zan.kz/rus/docs/V1600014365
// Apply on seller configuration / new invoice issuance, never to an old snapshot.
const SUBSCRIPTION_KNP = "851";
// Assets are stored in the invoice snapshot, so later seller edits cannot alter it.
const pngDataUrl = z.string().max(350000).refine((value) => {
  if (!value) return true;
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value.slice(22), "base64");
  return bytes.length >= 33 && bytes.length <= 256 * 1024 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 2048 &&
    bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 2048;
}, "Загрузите PNG до 256 КБ и до 2048 × 2048 пикселей").optional();
export const sellerSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  bin: z.string().regex(/^\d{12}$/),
  legalAddress: z.string().trim().min(3).max(500),
  iban: z.string().regex(/^KZ[A-Z0-9]{18}$/),
  bankName: z.string().trim().min(2).max(200),
  bik: z.string().regex(/^[A-Z0-9]{8,11}$/),
  kbe: z.string().regex(/^\d{2}$/),
  knp: z.string().trim().regex(/^(?:\d{3})?$/).optional(),
  signerName: z.string().trim().max(200).optional(),
  signerPosition: z.string().trim().max(120).optional(),
  signatureDataUrl: pngDataUrl,
  stampDataUrl: pngDataUrl,
  vatEnabled: z.boolean(),
  vatRate: z.number().min(0).max(100),
  supportEmail: z.email(),
  supportPhone: z.string().max(40),
  invoicePrefix: z.string().regex(/^[A-Z0-9-]{2,16}$/),
}).refine((s) => !s.signatureDataUrl || Boolean(s.signerName), {
  message: "Укажите ФИО подписанта для загруженной подписи", path: ["signerName"],
});
export const buyerSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  bin: z.string().regex(/^\d{12}$/),
  legalAddress: z.string().trim().min(3).max(500),
  email: z.email(),
  phone: z.string().trim().min(5).max(40),
});
// Invoice images are only needed by the admin editor and PDF download, not polling.
export function sellerDetailsWithoutImages(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { signatureDataUrl: _signature, stampDataUrl: _stamp, ...details } = value as Record<string, unknown>;
  return details;
}
export async function sellerProfile(db: DB) {
  const row = await db.platformSetting.findUnique({
    where: { key: "billing.seller" },
  });
  const result = sellerSchema.safeParse(row?.valueJson);
  return result.success ? { ...result.data, knp: result.data.knp || SUBSCRIPTION_KNP } : null;
}
export async function saveSeller(
  db: PrismaClient,
  auth: AuthContext,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const seller = sellerSchema.parse(input);
  seller.knp ||= SUBSCRIPTION_KNP;
  for (const value of [seller.signatureDataUrl, seller.stampDataUrl]) {
    if (!value) continue;
    try { await loadImage(Buffer.from(value.slice(22), "base64")); }
    catch { billingError("invalid_invoice_image", "Не удалось прочитать PNG подписи или печати"); }
  }
  return db.$transaction(async (tx) => {
    await tx.platformSetting.upsert({
      where: { key: "billing.seller" },
      create: { key: "billing.seller", valueJson: seller },
      update: { valueJson: seller },
    });
    await writeAudit(tx, {
      actorUserId: auth.user.id,
      action: "billing.seller.updated",
      entityType: "platform_setting",
      changes: { legalName: seller.legalName },
    });
    return seller;
  });
}
export async function nextNumber(db: DB, prefix: string) {
  const key = `${prefix}-${new Date().getUTCFullYear()}`;
  const seq = await db.billingSequence.upsert({
    where: { key },
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${key}-${String(seq.value).padStart(6, "0")}`;
}
export async function issueInvoice(
  db: DB,
  order: {
    id: string;
    tenantId: string;
    amountMinor: number;
    currency: string;
    description: string;
    expiresAt: Date;
    orderNumber?: string;
    createdAt?: Date;
  },
  paymentId: string,
  buyerInput?: unknown,
) {
  const existing = await db.billingInvoice.findUnique({
    where: { orderId: order.id },
  });
  if (existing) return existing;
  const seller = await sellerProfile(db);
  if (!seller)
    billingError(
      "seller_profile_missing",
      "Администратор ещё не заполнил реквизиты продавца",
    );
  const profile = await db.tenantLegalProfile.findUnique({
    where: { tenantId: order.tenantId },
  });
  const buyer = buyerSchema.parse(
    buyerInput || { ...profile, bin: profile?.bin || profile?.iin },
  );
  if (buyerInput)
    await db.tenantLegalProfile.upsert({
      where: { tenantId: order.tenantId },
      create: { tenantId: order.tenantId, ...buyer },
      update: buyer,
    });
  return db.billingInvoice.create({
    data: {
      invoiceNumber: await nextNumber(db, seller.invoicePrefix),
      tenantId: order.tenantId,
      orderId: order.id,
      paymentId,
      sellerJson: {
        ...seller,
        ...(order.orderNumber && order.createdAt ? {
          orderBasis: { number: order.orderNumber, date: order.createdAt.toISOString() },
        } : {}),
      },
      buyerJson: buyer,
      amountMinor: order.amountMinor,
      currency: order.currency,
      description: order.description,
      dueDate: order.expiresAt,
    },
  });
}
export async function renderBillingInvoice(invoice: {
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date;
  description: string;
  amountMinor: number;
  sellerJson: unknown;
  buyerJson: unknown;
  status: string;
}) {
  const seller = sellerSchema.parse(invoice.sellerJson);
  const buyer = buyerSchema.parse(invoice.buyerJson);
  const { orderBasis } = z.object({
    orderBasis: z.object({ number: z.string().max(100), date: z.iso.datetime() }).optional(),
  }).parse(invoice.sellerJson);
  return renderSubscriptionInvoice({ ...invoice, seller, buyer, orderBasis });
}
