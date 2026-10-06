import type { Prisma, PrismaClient } from "@creolab/db";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { collectPdf, resolveFont, formatKzt } from "../contractPdf.ts";
import { billingError } from "./config.ts";
import { writeAudit } from "../../lib/audit.ts";
import { requirePlatformAdmin } from "../../lib/access.ts";
import type { AuthContext } from "../../lib/types.ts";

type DB = PrismaClient | Prisma.TransactionClient;
export const sellerSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  bin: z.string().regex(/^\d{12}$/),
  legalAddress: z.string().trim().min(3).max(500),
  iban: z.string().regex(/^KZ[A-Z0-9]{18}$/),
  bankName: z.string().trim().min(2).max(200),
  bik: z.string().regex(/^[A-Z0-9]{8,11}$/),
  kbe: z.string().regex(/^\d{2}$/),
  vatEnabled: z.boolean(),
  vatRate: z.number().min(0).max(100),
  supportEmail: z.email(),
  supportPhone: z.string().max(40),
  invoicePrefix: z.string().regex(/^[A-Z0-9-]{2,16}$/),
});
export const buyerSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  bin: z.string().regex(/^\d{12}$/),
  legalAddress: z.string().trim().min(3).max(500),
  email: z.email(),
  phone: z.string().trim().min(5).max(40),
});
export async function sellerProfile(db: DB) {
  const row = await db.platformSetting.findUnique({
    where: { key: "billing.seller" },
  });
  const result = sellerSchema.safeParse(row?.valueJson);
  return result.success ? result.data : null;
}
export async function saveSeller(
  db: PrismaClient,
  auth: AuthContext,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const seller = sellerSchema.parse(input);
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
      sellerJson: seller,
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
  const s = sellerSchema.parse(invoice.sellerJson),
    b = buyerSchema.parse(invoice.buyerJson);
  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    info: { Title: `BasQar · ${invoice.invoiceNumber}` },
  });
  const done = collectPdf(doc);
  doc
    .registerFont("regular", resolveFont("NotoSans-Regular.ttf"))
    .registerFont("bold", resolveFont("NotoSans-Bold.ttf"));
  doc.fillColor("#0866c6").font("bold").fontSize(28).text("BasQar");
  doc.moveDown().fillColor("#17243c").fontSize(18).text("СЧЁТ НА ОПЛАТУ");
  doc
    .font("regular")
    .fontSize(10)
    .text(
      `${invoice.invoiceNumber} · ${invoice.issueDate.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" })}`,
    );
  doc.text(
    (
      {
        PAID: "Оплачено",
        CANCELLED: "Отменён — не оплачивать",
        EXPIRED: "Срок оплаты истёк — не оплачивать",
      } as Record<string, string>
    )[invoice.status] || "Ожидает оплаты",
  );
  doc
    .moveDown()
    .font("bold")
    .text("Поставщик")
    .font("regular")
    .text(
      `${s.legalName}\nБИН: ${s.bin}\n${s.legalAddress}\nИИК: ${s.iban}\n${s.bankName}\nБИК: ${s.bik} · КБе: ${s.kbe}`,
    );
  doc
    .moveDown()
    .font("bold")
    .text("Покупатель")
    .font("regular")
    .text(`${b.legalName}\nБИН / ИИН: ${b.bin}\n${b.legalAddress}`);
  doc.moveDown();
  const y = doc.y;
  doc.moveTo(48, y).lineTo(548, y).strokeColor("#d9e1eb").stroke();
  doc.moveDown().font("bold").text("Наименование", 48, doc.y, { width: 350 });
  doc.text("Сумма", 425, doc.y - 14, { width: 123, align: "right" });
  const rowY = doc.y + 12;
  doc
    .font("regular")
    .text(`1. ${invoice.description}`, 48, rowY, { width: 340 });
  const rowBottom = doc.y;
  doc.text(formatKzt(invoice.amountMinor), 410, rowY, {
    width: 138,
    align: "right",
  });
  doc.y = Math.max(rowBottom, doc.y) + 20;
  doc.font("bold").text(`Итого: ${formatKzt(invoice.amountMinor)}`, 48, doc.y, {
    align: "right",
  });
  doc
    .font("regular")
    .fontSize(10)
    .text(
      s.vatEnabled
        ? `В том числе НДС ${s.vatRate}%: ${formatKzt((invoice.amountMinor * s.vatRate) / (100 + s.vatRate))}`
        : "Без НДС",
      { align: "right" },
    );
  doc
    .moveDown(2)
    .text(
      `Назначение платежа: Оплата подписки BasQar по счёту ${invoice.invoiceNumber}.`,
    );
  doc
    .moveDown()
    .text(
      `Оплатить до ${invoice.dueDate.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" })}.`,
    );
  doc.moveDown().text(`${s.supportEmail} · ${s.supportPhone}`);
  doc
    .moveDown()
    .fillColor("#63738a")
    .text("Счёт на оплату не является фискальным чеком.");
  doc.end();
  return done;
}
