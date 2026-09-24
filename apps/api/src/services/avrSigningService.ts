import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { Response } from "express";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { assertFileCapacity } from "./billingResourceService.ts";
import { renderAvrPdf } from "./avrPdf.ts";
import type { AvrSourceSnapshot } from "./avrMapper.ts";
import { verifyDocumentSignature } from "./signatureVerificationService.ts";
import { signatureVerificationFailureMessage, signatureVerificationUnavailableMessage } from "./signatureVerificationError.ts";
import { decodeCmsDer } from "./cmsInspect.ts";
import { buildSignedDocumentExport } from "./contractSignedExport.ts";

type Db = PrismaClient | Prisma.TransactionClient;
type Signing = NonNullable<Awaited<ReturnType<PrismaClient["avrSigning"]["findFirst"]>>>;
type Snapshot = AvrSourceSnapshot & { number: string };
type Signature = {
  fileId: string; checksum: string; documentHash: string; name: string; bin: string | null; iin: string | null;
  signedAt: string; certificateSerial: string | null; verificationStatus: string;
  verificationDetails: Record<string, unknown>;
};
const hash = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
const signature = (value: unknown) => value as Signature | null;
const snapshot = (row: Signing) => row.snapshotJson as unknown as Snapshot;
const verified = (value: Signature | null, sha: string) => Boolean(value && value.documentHash === sha && value.verificationStatus === "VERIFIED" && value.verificationDetails?.authority === "VALID" && value.verificationDetails?.crypto === "kalkan_cms_verified");
const mask = (value: string | null) => value ? `••••••••${value.slice(-4)}` : null;

function tenant(auth: AuthContext, permission?: "manage_documents" | "sign_documents") {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  if (permission && !can(auth, permission)) throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  return auth.activeMembership.tenantId;
}
async function enabled(db: Db, tid: string) {
  const flags = await requireDocumentsEnabled(db as PrismaClient, tid);
  if (!flags.contractSigningEnabled) throw new ApiError(403, "signing_disabled", "Включите подписание ЭЦП в реквизитах компании");
}
async function lock(db: Prisma.TransactionClient, tid: string, id: string) {
  await db.$queryRaw`SELECT id FROM "ElectronicDocument" WHERE id = ${id} AND "tenantId" = ${tid} FOR UPDATE`;
}
async function load(db: Db, tid: string, documentId: string) {
  const row = await db.avrSigning.findFirst({ where: { tenantId: tid, documentId } });
  if (!row) throw new ApiError(404, "not_found", "АВР ещё не подготовлен к подписанию в BasQar");
  return row;
}
async function checkedFile(db: Db, tid: string, id: string, sha: string) {
  const file = await db.attachment.findFirst({ where: { id, tenantId: tid } });
  if (!file || file.checksum !== sha) throw new ApiError(409, "signed_file_missing", "Не найден оригинал или файл ЭЦП");
  const bytes = await readFile(resolveUploadPath(file.storageKey)).catch(() => { throw new ApiError(409, "signed_file_missing", "Файл недоступен"); });
  if (hash(bytes) !== sha) throw new ApiError(409, "DOCUMENT_CHANGED", "Нарушена целостность документа или ЭЦП. Действие остановлено.");
  return bytes;
}
async function storeFile(db: Db, tid: string, id: string, bytes: Buffer, kind: "pdf" | "p7s", userId: string | null) {
  await assertFileCapacity(db as PrismaClient, tid, bytes.length);
  const fileId = randomUUID();
  const storageKey = path.posix.join(tid, "avr-signatures", id, `${fileId}.${kind}`);
  const absolute = resolveUploadPath(storageKey);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return { absolute, data: { id: fileId, tenantId: tid, parentType: "avr_signing", parentId: id,
    storageKey, fileName: `${id}.${kind}`, originalFileName: `${id}.${kind}`,
    mimeType: kind === "pdf" ? "application/pdf" : "application/pkcs7-signature", sizeBytes: bytes.length,
    checksum: hash(bytes), uploadedById: userId, status: "stored", documentType: kind === "pdf" ? "avr" : "signature" } };
}
function signers(row: Signing) {
  return ([['SELLER', signature(row.sellerSignature)], ['BUYER', signature(row.buyerSignature)]] as const)
    .filter((entry): entry is readonly ["SELLER" | "BUYER", Signature] => Boolean(entry[1]))
    .map(([role, sig]) => ({ role, name: sig.name, iin: mask(sig.iin), signedAt: sig.signedAt,
      verificationStatus: sig.verificationStatus,
      authorityStatus: String(sig.verificationDetails.authority || "UNCHECKED"),
      cryptoStatus: sig.verificationDetails.crypto === "kalkan_cms_verified" ? "VERIFIED" : "UNCHECKED" }));
}
function view(row: Signing) {
  const source = snapshot(row);
  return { documentType: "AVR", number: source.number, date: source.documentDate, version: 1,
    subject: `Акт выполненных работ ${source.number}`, amount: source.totals.totalAmount, currency: source.totals.currency,
    sellerName: source.seller.legalName, buyerName: source.buyer.legalName || source.buyer.name,
    status: row.status, contractStatus: row.status, signedAt: row.signedAt?.toISOString() || null,
    expiresAt: row.expiresAt?.toISOString() || null, declinedAt: row.declinedAt?.toISOString() || null,
    declineReason: row.declineReason, signers: signers(row),
    verificationUrl: `/verify/avr/${row.verificationPublicId}` };
}
export async function getAvrSigning(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireDocumentsAccess(auth);
  const tid = tenant(auth);
  const doc = await prisma.electronicDocument.findFirst({ where: { id, tenantId: tid, type: "AVR" } });
  if (!doc) throw new ApiError(404, "not_found", "АВР не найден");
  const row = await prisma.avrSigning.findFirst({ where: { tenantId: tid, documentId: id } });
  return row ? view(row) : { status: null, signers: [], documentType: "AVR" };
}

export async function prepareAvrSeller(prisma: PrismaClient, auth: AuthContext, id: string) {
  const tid = tenant(auth, "manage_documents");
  await enabled(prisma, tid);
  const existing = await prisma.avrSigning.findFirst({ where: { tenantId: tid, documentId: id } });
  if (existing) return view(existing);
  const doc = await prisma.electronicDocument.findFirst({ where: { id, tenantId: tid, type: "AVR" } });
  if (!doc) throw new ApiError(404, "not_found", "АВР не найден");
  if (doc.status !== "VALIDATED" || doc.externalId || doc.externalSystem) throw new ApiError(409, "avr_not_ready", "Сначала проверьте АВР. Уже отправленный документ нельзя передать на другое подписание.");
  const source = doc.sourceDataJson as unknown as AvrSourceSnapshot;
  const sellerId = source.seller?.bin || source.seller?.iin;
  const buyerId = source.buyer?.bin || source.buyer?.iin;
  if (!/^\d{12}$/.test(sellerId || "") || !/^\d{12}$/.test(buyerId || "")) throw new ApiError(422, "missing_fields", "Проверьте БИН / ИИН обеих сторон");
  if (sellerId === buyerId) throw new ApiError(422, "same_parties", "БИН / ИИН заказчика совпадает с исполнителем. Исправьте реквизиты заказчика перед подписанием.");
  const { buffer } = await renderAvrPdf({ number: doc.number, source });
  const file = await storeFile(prisma, tid, id, buffer, "pdf", auth.user.id);
  let stored = false;
  try {
    const row = await prisma.$transaction(async tx => {
      await lock(tx, tid, id);
      const reused = await tx.avrSigning.findFirst({ where: { tenantId: tid, documentId: id } });
      if (reused) return reused;
      const current = await tx.electronicDocument.findFirst({ where: { id, tenantId: tid } });
      if (!current || current.status !== "VALIDATED" || current.externalId || current.externalSystem || current.updatedAt.getTime() !== doc.updatedAt.getTime()) throw new ApiError(409, "DOCUMENT_CHANGED", "АВР изменён. Откройте его заново.");
      await tx.attachment.create({ data: file.data });
      const created = await tx.avrSigning.create({ data: { tenantId: tid, documentId: id, originalFileId: file.data.id,
        documentHash: file.data.checksum, snapshotJson: { ...source, number: doc.number } as unknown as Prisma.InputJsonValue } });
      await tx.electronicDocument.update({ where: { id }, data: { status: "PENDING_SIGNATURE", externalSystem: "BASQAR", xmlStorageKey: null, errorCode: null, errorMessage: null } });
      await tx.auditEvent.create({ data: { tenantId: tid, actorUserId: auth.user.id, action: "avr.prepare_seller_sign", entityType: "electronic_document", entityId: id, changesJson: { documentHash: created.documentHash } } });
      return created;
    });
    stored = row.originalFileId === file.data.id;
    return view(row);
  } finally { if (!stored) await rm(file.absolute, { force: true }); }
}

export async function sendAvrToBuyer(prisma: PrismaClient, auth: AuthContext, id: string) {
  const tid = tenant(auth, "manage_documents");
  await enabled(prisma, tid);
  const token = randomBytes(32).toString("base64url");
  const row = await prisma.$transaction(async tx => {
    await lock(tx, tid, id);
    const current = await load(tx, tid, id);
    if (!verified(signature(current.sellerSignature), current.documentHash)) throw new ApiError(422, "seller_must_sign_first", "Сначала подпишите АВР со стороны компании");
    if (current.buyerSignature || current.status === "SIGNED") throw new ApiError(409, "already_signed", "АВР уже подписан обеими сторонами");
    await checkedFile(tx, tid, current.originalFileId, current.documentHash);
    const next = await tx.avrSigning.update({ where: { id: current.id }, data: { buyerTokenHash: hash(token), expiresAt: new Date(Date.now() + 14 * 86400000), openedAt: null, declinedAt: null, declineReason: null } });
    await tx.auditEvent.create({ data: { tenantId: tid, actorUserId: auth.user.id, action: "avr.buyer_link_created", entityType: "electronic_document", entityId: id, changesJson: {} } });
    return next;
  });
  return { ...view(row), signUrl: `${config.appBaseUrl.replace(/\/$/, "")}/sign/avr/${token}` };
}
function assertBuyerOpen(row: Signing) {
  if (row.buyerSignature || row.status === "SIGNED") throw new ApiError(409, "already_processed", "АВР уже подписан");
  if (row.declinedAt) throw new ApiError(409, "already_processed", "АВР отклонён заказчиком");
  if (!row.expiresAt || row.expiresAt.getTime() <= Date.now()) throw new ApiError(410, "signature_expired", "Срок ссылки истёк. Запросите новую ссылку у исполнителя.");
  if (!verified(signature(row.sellerSignature), row.documentHash)) throw new ApiError(409, "seller_must_sign_first", "Сначала подписывает исполнитель");
}
async function publicRow(db: Db, token: string) {
  const row = await db.avrSigning.findUnique({ where: { buyerTokenHash: hash(token) } });
  if (!row) throw new ApiError(404, "not_found", "Ссылка недействительна или заменена новой");
  // A completed buyer retains access to the archive; expired unsigned links do not expose PDFs.
  if (row.status !== "SIGNED" && (!row.expiresAt || row.expiresAt.getTime() <= Date.now())) throw new ApiError(410, "signature_expired", "Срок ссылки истёк. Запросите новую ссылку у исполнителя.");
  return row;
}
export async function getPublicAvrSign(prisma: PrismaClient, token: string) {
  const row = await publicRow(prisma, token);
  if (!row.openedAt) await prisma.avrSigning.updateMany({ where: { id: row.id, buyerTokenHash: hash(token), openedAt: null }, data: { openedAt: new Date() } });
  const flags = await requireDocumentsEnabled(prisma, row.tenantId);
  const canSign = flags.contractSigningEnabled && !row.declinedAt && !row.buyerSignature && verified(signature(row.sellerSignature), row.documentHash);
  return { ...view(row), canSign, canDecline: canSign, waitingForSeller: false };
}
export async function sendAvrSigningPdf(prisma: PrismaClient, res: Response, input: { auth: AuthContext; id: string } | { token: string }) {
  let row: Signing;
  if ("auth" in input) { requireDocumentsAccess(input.auth); row = await load(prisma, tenant(input.auth), input.id); }
  else row = await publicRow(prisma, input.token);
  const bytes = await checkedFile(prisma, row.tenantId, row.originalFileId, row.documentHash);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", 'inline; filename="avr-original.pdf"');
  res.send(bytes);
}

export async function submitAvrSignature(prisma: PrismaClient, cmsBase64: string, input: { auth: AuthContext; id: string } | { token: string }) {
  const isSeller = "auth" in input;
  const row = isSeller ? await load(prisma, tenant(input.auth, "sign_documents"), input.id) : await publicRow(prisma, input.token);
  await enabled(prisma, row.tenantId);
  if (isSeller) { if (row.sellerSignature) throw new ApiError(409, "already_processed", "Исполнитель уже подписал АВР"); }
  else assertBuyerOpen(row);
  const original = await checkedFile(prisma, row.tenantId, row.originalFileId, row.documentHash);
  const party = isSeller ? snapshot(row).seller : snapshot(row).buyer;
  const proof = await verifyDocumentSignature({ cmsBase64, documentHash: row.documentHash, documentBytes: original,
    expectedBin: party.bin || null, expectedIin: party.bin ? null : party.iin || null });
  if (proof.status !== "VERIFIED") {
    if (proof.cryptoStatus === "UNAVAILABLE" || proof.details.error === "certificate_authority_unchecked") throw new ApiError(503, "signature_verification_unavailable", signatureVerificationUnavailableMessage(String(proof.details.authorityError || proof.details.error || "verification_unavailable")));
    throw new ApiError(422, "signature_invalid", signatureVerificationFailureMessage(proof.details.error));
  }
  const cms = decodeCmsDer(cmsBase64);
  const file = await storeFile(prisma, row.tenantId, row.documentId, cms, "p7s", isSeller ? input.auth.user.id : null);
  let committed = false;
  try {
    const next = await prisma.$transaction(async tx => {
      await lock(tx, row.tenantId, row.documentId);
      const current = await load(tx, row.tenantId, row.documentId);
      if (current.documentHash !== row.documentHash || current.originalFileId !== row.originalFileId) throw new ApiError(409, "DOCUMENT_CHANGED", "АВР изменился");
      if (isSeller) { if (current.sellerSignature) throw new ApiError(409, "already_processed", "Исполнитель уже подписал АВР"); }
      else {
        if (current.buyerTokenHash !== hash(input.token)) throw new ApiError(409, "link_replaced", "Ссылка заменена новой");
        assertBuyerOpen(current);
      }
      await checkedFile(tx, row.tenantId, row.originalFileId, row.documentHash);
      const cert = proof.inspection?.primary;
      const signedAt = new Date();
      const sig: Signature = { fileId: file.data.id, checksum: file.data.checksum, documentHash: row.documentHash,
        name: cert?.commonName || party.directorName || party.legalName, bin: cert?.bin || party.bin || null, iin: cert?.iin || null,
        signedAt: signedAt.toISOString(), certificateSerial: cert?.serial || null, verificationStatus: proof.status, verificationDetails: proof.details };
      await tx.attachment.create({ data: file.data });
      const nextStatus = isSeller ? "PARTIALLY_SIGNED" : "SIGNED";
      const saved = await tx.avrSigning.update({ where: { id: row.id }, data: { status: nextStatus,
        ...(isSeller ? { sellerSignature: sig as Prisma.InputJsonValue } : { buyerSignature: sig as Prisma.InputJsonValue, signedAt }) } });
      await tx.electronicDocument.update({ where: { id: row.documentId }, data: { status: nextStatus,
        ...(isSeller ? { signedByUserId: input.auth.user.id } : { signedAt }) } });
      await tx.auditEvent.create({ data: { tenantId: row.tenantId, actorUserId: isSeller ? input.auth.user.id : null,
        action: isSeller ? "avr.partially_signed" : "avr.signed", entityType: "electronic_document", entityId: row.documentId,
        changesJson: { signerType: isSeller ? "SELLER" : "BUYER", documentHash: row.documentHash } } });
      return saved;
    });
    committed = true;
    return { ...view(next), bothSigned: next.status === "SIGNED" };
  } finally { if (!committed) await rm(file.absolute, { force: true }); }
}
export async function declinePublicAvr(prisma: PrismaClient, token: string, reason?: string | null) {
  const row = await publicRow(prisma, token);
  await prisma.$transaction(async tx => {
    await lock(tx, row.tenantId, row.documentId);
    const current = await publicRow(tx, token);
    assertBuyerOpen(current);
    await tx.avrSigning.update({ where: { id: row.id }, data: { declinedAt: new Date(), declineReason: reason?.trim() || null } });
    await tx.auditEvent.create({ data: { tenantId: row.tenantId, action: "avr.buyer_declined", entityType: "electronic_document", entityId: row.documentId, changesJson: {} } });
  });
  return { ok: true };
}
export async function getPublicAvrVerification(prisma: PrismaClient, verificationId: string) {
  const row = await prisma.avrSigning.findUnique({ where: { verificationPublicId: verificationId } });
  if (!row) throw new ApiError(404, "not_found", "Проверка не найдена");
  const v = view(row);
  // Public verification discloses no PDF, download token, full tax ID or internal identifiers.
  return { documentType: "AVR", number: v.number, date: v.date, version: 1, status: v.status, signedAt: v.signedAt,
    sellerName: v.sellerName, buyerName: v.buyerName, signers: v.signers, documentHash: row.documentHash, hashAlgorithm: "SHA-256" };
}
export async function downloadSignedAvr(prisma: PrismaClient, format: "pdf" | "zip", input: { auth: AuthContext; id: string } | { token: string }) {
  let row: Signing;
  if ("auth" in input) { requireDocumentsAccess(input.auth); row = await load(prisma, tenant(input.auth), input.id); }
  else row = await publicRow(prisma, input.token);
  const seller = signature(row.sellerSignature), buyer = signature(row.buyerSignature);
  if (row.status !== "SIGNED" || !verified(seller, row.documentHash) || !verified(buyer, row.documentHash)) throw new ApiError(409, "both_signatures_required", "Скачивание доступно после проверенных подписей обеих сторон");
  const original = await checkedFile(prisma, row.tenantId, row.originalFileId, row.documentHash);
  const signatures = [seller!, buyer!];
  const files = await Promise.all(signatures.map(sig => checkedFile(prisma, row.tenantId, sig.fileId, sig.checksum)));
  const source = snapshot(row);
  return buildSignedDocumentExport(original, files, { documentLabel: "АВР", number: source.number, version: 1,
    documentHash: row.documentHash, verificationUrl: `${config.appBaseUrl.replace(/\/$/, "")}/verify/avr/${row.verificationPublicId}`,
    signers: signatures.map((sig, i) => ({ role: i ? "BUYER" : "SELLER", name: sig.name,
      organization: i ? source.buyer.legalName || source.buyer.name : source.seller.legalName,
      bin: sig.bin, iin: mask(sig.iin), signedAt: sig.signedAt, certificateSerial: sig.certificateSerial })) }, format);
}
