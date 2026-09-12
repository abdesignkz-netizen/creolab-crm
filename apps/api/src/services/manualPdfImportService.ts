import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "@creolab/db";
import { validateClientPhone, type PdfImportPreview } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { extractPdfPages } from "./pdfTextExtraction.ts";
import { parsePdfDocument } from "./pdfDocumentParser.ts";
import { lineAmounts, sumLines, toMinorTenge } from "./documentMoney.ts";

const partySchema = z.object({ name: z.string().trim().max(300), bin: z.string().trim().regex(/^\d{12}$|^$/, "БИН должен содержать 12 цифр"), legalAddress: z.string().trim().max(1000), iban: z.string().trim().regex(/^KZ[A-Z0-9]{18}$|^$/, "Проверьте IBAN"), bankName: z.string().trim().max(300), bik: z.string().trim().regex(/^[A-Z0-9]{8,11}$|^$/, "Проверьте БИК"), directorName: z.string().trim().max(200) });
const commitSchema = z.object({
  importId: z.string().uuid(), dealId: z.string().uuid().optional(),
  draft: z.object({
    kind: z.enum(["CONTRACT", "INVOICE"]), number: z.string().trim().min(1).max(100),
    date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(s => { const d = new Date(s); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === s; }, "Укажите корректную дату"),
    subject: z.string().trim().min(1).max(1000), buyer: partySchema, seller: partySchema,
    contactName: z.string().trim().max(200), contactPhone: z.string().trim().max(40),
    paymentTerms: z.string().max(4000), completionTerms: z.string().max(2000),
    detectedTotal: z.number().nonnegative().nullable(),
    items: z.array(z.object({ name: z.string().trim().min(1).max(1000), quantity: z.number().positive().max(1e6), unitPrice: z.number().nonnegative().max(1e10), vatRate: z.number().min(0).max(100), unit: z.string().trim().min(1).max(40) })).min(1).max(100),
  }),
});
let activeExtractions = 0;
async function access(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной организации");
  if (!can(auth, "manage_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для загрузки документов");
  await requireDocumentsEnabled(prisma, auth.activeMembership.tenantId);
  return auth.activeMembership;
}

export async function previewManualPdf(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<PdfImportPreview> {
  const membership = await access(prisma, auth);
  const input = z.object({ kind: z.enum(["CONTRACT", "INVOICE"]), fileName: z.string().min(1).max(255), fileBase64: z.string().max(28_000_000) }).parse(raw);
  if (!/\.pdf$/i.test(input.fileName) || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.fileBase64)) throw new ApiError(422, "pdf_required", "Выберите файл PDF");
  const bytes = Buffer.from(input.fileBase64, "base64");
  if (bytes.length > 20 * 1024 * 1024 || bytes.length < 8 || !bytes.subarray(0,8).toString().startsWith("%PDF-")) throw new ApiError(422, "pdf_invalid", "Нужен PDF размером до 20 МБ");
  if (activeExtractions >= 2) throw new ApiError(429, "pdf_import_busy", "Сейчас распознаются другие документы. Повторите чуть позже.");
  activeExtractions++;
  try {
    const pages = await extractPdfPages(bytes);
    if (!pages.some(p=>p.text.trim())) throw new ApiError(422, "pdf_no_text", "На страницах не удалось распознать текст. Загрузите более чёткий скан.");
    const legal = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
    const { draft, warnings } = parsePdfDocument(pages, input.kind, legal?.bin);
    const importId = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = path.posix.join(membership.tenantId, "manual-pdf", `${importId}.pdf`);
    const absolute = resolveUploadPath(storageKey);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes, { flag: "wx" });
    try {
      await prisma.attachment.create({ data: { id: importId, tenantId: membership.tenantId, parentType: "document_import", parentId: importId, documentType: input.kind.toLowerCase(), storageKey, fileName: `${importId}.pdf`, originalFileName: path.basename(input.fileName), mimeType: "application/pdf", sizeBytes: bytes.length, checksum: sha256, status: "preview", uploadedById: auth.user.id } });
    } catch (error) { await rm(absolute, { force: true }); throw error; }
    return { importId, fileName: path.basename(input.fileName), sha256, pageCount: pages.length, usedOcr: pages.some(p=>p.ocr), draft, warnings, pages: pages.map(({page,text})=>({page,text})) };
  } finally { activeExtractions--; }
}

export async function commitManualPdf(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const membership = await access(prisma, auth);
  const { importId, draft, dealId: requestedDealId } = commitSchema.parse(raw);
  const tid = membership.tenantId;
  const file = await prisma.attachment.findFirst({ where: { id: importId, tenantId: tid } });
  if (!file || file.documentType !== draft.kind.toLowerCase()) throw new ApiError(404, "not_found", "Загруженный PDF не найден");
  const bytes = await readFile(resolveUploadPath(file.storageKey));
  if (createHash("sha256").update(bytes).digest("hex") !== file.checksum) throw new ApiError(409, "pdf_changed", "Файл изменился. Загрузите PDF заново.");
  const items = draft.items.map(item=>({ ...item, ...lineAmounts(item.quantity,item.unitPrice,item.vatRate) }));
  const totals = sumLines(items);
  if (totals.totalAmount <= 0) throw new ApiError(422, "pdf_amount_required", "Укажите стоимость работ");
  if (draft.detectedTotal !== null && Math.abs(totals.totalAmount - draft.detectedTotal) > 0.01) throw new ApiError(422, "pdf_total_mismatch", "Сумма позиций не совпадает с итогом. Проверьте количество, цены, НДС и итог PDF.");
  if (draft.kind === "CONTRACT" && !draft.buyer.name) throw new ApiError(422, "pdf_buyer_required", "Укажите заказчика");
  const phone = draft.kind === "CONTRACT" ? validateClientPhone(draft.contactPhone, membership.tenant.defaultRegion) : null;
  if (phone && !phone.ok) throw new ApiError(422, "pdf_phone_required", "Укажите корректный телефон контактного лица заказчика");
  if (draft.kind === "INVOICE" && !requestedDealId) throw new ApiError(422, "pdf_deal_required", "Выберите сделку для счёта");
  try {
    return await prisma.$transaction(async tx => {
      // Serialize imports per tenant, including different uploads of the same PDF.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tid} FOR UPDATE`;
      // The row update serializes concurrent confirmations of this same upload.
      const claimed = await tx.attachment.updateMany({ where: { id: importId, tenantId: tid, status: "preview", parentType: "document_import" }, data: { status: "importing" } });
      if (!claimed.count) {
        const existing = await tx.attachment.findFirst({ where: { id: importId, tenantId: tid, status: "imported" } });
        if (existing) {
          const doc = draft.kind === "CONTRACT" ? await tx.contract.findFirst({ where: { id: existing.parentId, tenantId: tid } }) : await tx.invoice.findFirst({ where: { id: existing.parentId, tenantId: tid } });
          if (doc) return { documentId: doc.id, dealId: doc.dealId, kind: draft.kind, reused: true };
        }
        throw new ApiError(409, "pdf_import_in_progress", "Этот PDF уже обрабатывается");
      }
      const duplicate = await tx.attachment.findFirst({ where: { tenantId: tid, checksum: file.checksum, documentType: file.documentType, status: "imported", id: { not: importId } } });
      if (duplicate) throw new ApiError(409, "pdf_already_imported", "Этот PDF уже загружен в документы");
      let dealId = requestedDealId || "", companyId: string | null = null, contractId: string | null = null;
      if (draft.kind === "CONTRACT") {
        let company = draft.buyer.bin ? await tx.company.findFirst({ where: { tenantId: tid, bin: draft.buyer.bin, archivedAt: null } }) : null;
        if (!company) company = await tx.company.create({ data: { tenantId: tid, name: draft.buyer.name, nameNormalized: draft.buyer.name.toLowerCase(), legalName: draft.buyer.name, bin: draft.buyer.bin || null, legalAddress: draft.buyer.legalAddress || null, iban: draft.buyer.iban || null, bik: draft.buyer.bik || null, bankName: draft.buyer.bankName || null, directorName: draft.buyer.directorName || null, initialSource: "manual_pdf", assigneeMembershipId: membership.id } });
        else {
          // Fill missing details only. Existing customer data is never silently replaced.
          const missing: Record<string,string> = {};
          for (const key of ["legalAddress","iban","bik","bankName","directorName"] as const) if (!company[key] && draft.buyer[key]) missing[key] = draft.buyer[key];
          if (Object.keys(missing).length) company = await tx.company.update({ where: { id: company.id }, data: missing });
        }
        companyId = company.id;
        const normalized = phone && phone.ok ? phone.normalized : "";
        const method = await tx.contactMethod.findFirst({ where: { tenantId: tid, type: "phone", normalizedValue: normalized } });
        let contactId = method?.contactId;
        if (!contactId) {
          const contact = await tx.contact.create({ data: { tenantId: tid, name: draft.contactName || draft.buyer.directorName || draft.buyer.name, companyName: draft.buyer.name, ownerMembershipId: membership.id, attributionJson: { source: "manual_pdf" } } });
          contactId = contact.id;
          await tx.contactMethod.create({ data: { tenantId: tid, contactId, type: "phone", rawValue: draft.contactPhone, normalizedValue: normalized, source: "manual_pdf", primary: true } });
        }
        await tx.companyContact.upsert({ where: { tenantId_companyId_contactId: { tenantId: tid, companyId, contactId } }, create: { tenantId: tid, companyId, contactId, isPrimary: true }, update: {} });
        const stage = await tx.dealStage.findFirst({ where: { tenantId: tid, systemKey: "new" } });
        if (!stage) throw new ApiError(422, "pipeline_required", "Воронка сделок не настроена");
        const deal = await tx.deal.create({ data: { tenantId: tid, contactId, companyId, title: draft.subject.slice(0,250), description: `Импорт договора № ${draft.number} от ${draft.date}.\n${draft.subject}`, stageId: stage.id, offerAmountMinor: toMinorTenge(totals.totalAmount), assigneeMembershipId: membership.id, nextAction: "Проверить загруженный договор и его подписание" } });
        dealId = deal.id;
        await tx.dealStageHistory.create({ data: { tenantId: tid, dealId, toStageId: stage.id, toSystemKey: stage.systemKey, enteredAt: new Date(), changedByType: "user", changedById: auth.user.id, note: "Создана из PDF договора" } });
        await tx.dealItem.createMany({ data: items.map((item,sortOrder)=>({ ...item, tenantId: tid, dealId, sortOrder })) });
      } else {
        const deal = await tx.deal.findFirst({ where: { id: dealId, tenantId: tid } });
        if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
        companyId = deal.companyId;
        const company = companyId ? await tx.company.findFirst({ where: { id: companyId, tenantId: tid } }) : null;
        if (company?.bin && draft.buyer.bin && company.bin !== draft.buyer.bin) throw new ApiError(422, "pdf_buyer_mismatch", "Заказчик счёта не совпадает с компанией сделки");
        const contract = await tx.contract.findFirst({ where: { tenantId: tid, dealId }, orderBy: { createdAt: "desc" } });
        contractId = contract?.id || null;
      }
      let documentId: string;
      if (draft.kind === "CONTRACT") {
        const contract = await tx.contract.create({ data: { tenantId: tid, dealId, companyId, number: draft.number, date: new Date(draft.date), subject: draft.subject, paymentTerms: draft.paymentTerms || null, completionTerms: draft.completionTerms || null, ...totals, status: "READY_TO_SIGN", originalFileId: importId, generatedFileId: importId, createdByUserId: auth.user.id } });
        documentId = contract.id;
        await tx.contractVersion.create({ data: { tenantId: tid, contractId: documentId, version: 1, fileId: importId, sha256: file.checksum } });
      } else {
        const invoice = await tx.invoice.create({ data: { tenantId: tid, dealId, companyId, contractId, number: draft.number, date: new Date(draft.date), ...totals, status: "ISSUED", pdfFileId: importId, createdByUserId: auth.user.id } });
        documentId = invoice.id;
        await tx.invoiceItem.createMany({ data: items.map((item,sortOrder)=>({ ...item, tenantId: tid, invoiceId: documentId, sortOrder })) });
        await tx.deal.updateMany({ where: { id: dealId, tenantId: tid, paymentStatus: "NOT_INVOICED" }, data: { paymentStatus: "INVOICED" } });
      }
      await tx.attachment.update({ where: { id: importId }, data: { parentType: draft.kind.toLowerCase(), parentId: documentId, status: "imported" } });
      await tx.auditEvent.create({ data: { tenantId: tid, actorUserId: auth.user.id, action: "document.import_pdf", entityType: draft.kind.toLowerCase(), entityId: documentId, changesJson: { dealId, sha256: file.checksum, number: draft.number, reviewedImport: draft, signatureVerified: false } } });
      return { documentId, dealId, kind: draft.kind, reused: false };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new ApiError(409, "document_number_exists", "Документ с таким номером уже существует. Проверьте номер или откройте существующий документ.");
    throw error;
  }
}

export async function discardManualPdf(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = await access(prisma, auth);
  z.string().uuid().parse(id);
  const removed = await prisma.attachment.deleteMany({ where: { id, tenantId: membership.tenantId, status: "preview", parentType: "document_import" } });
  if (removed.count) await rm(resolveUploadPath(path.posix.join(membership.tenantId, "manual-pdf", `${id}.pdf`)), { force: true });
  return { ok: true };
}
