import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import PDFKit from "pdfkit";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import QRCode from "qrcode";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { inspectCms } from "./cmsInspect.ts";
import { collectPdf, resolveFont } from "./contractPdf.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const mask = (value: string | null) => value ? `••••••••${value.slice(-4)}` : null;
export type SigningReceipt = {
  documentLabel?: string; number: string; version: number; documentHash: string; verificationUrl: string;
  signers: Array<{ role: string; name: string; organization: string | null; bin: string | null; iin: string | null; signedAt: string; certificateSerial: string | null }>;
};

/** A separate representation: never modify the bytes to which the CMS signatures bind. */
export async function renderSigningReceipt(receipt: SigningReceipt) {
  const doc = new PDFKit({ size: "A4", margin: 48, info: { Title: `Лист подписания ${receipt.number}`, Creator: "BasQar" } });
  const result = collectPdf(doc);
  doc.registerFont("regular", resolveFont("NotoSans-Regular.ttf"));
  doc.registerFont("bold", resolveFont("NotoSans-Bold.ttf"));
  doc.font("bold").fontSize(24).fillColor("#17243B").text("Лист подписания");
  doc.moveDown(.4).font("regular").fontSize(11).fillColor("#52627B").text(`${receipt.documentLabel || "Договор"} ${receipt.number} · версия ${receipt.version}`);
  doc.moveDown().font("bold").fontSize(15).fillColor("#13744B").text("Подписан обеими сторонами");
  for (const signer of receipt.signers) {
    if (doc.y > 600) doc.addPage();
    doc.moveDown().font("bold").fontSize(12).fillColor("#17243B").text(signer.role === "SELLER" ? "Исполнитель" : "Заказчик");
    if (signer.organization) doc.font("regular").fontSize(11).text(signer.organization);
    doc.font("regular").fontSize(11).text(`Подписант: ${signer.name}`);
    doc.text(signer.bin ? `БИН ${signer.bin}` : `ИИН ${signer.iin || "не указан"}`);
    doc.text(`Подписано: ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "long", timeStyle: "medium" }).format(new Date(signer.signedAt))} (Алматы)`);
    doc.fontSize(9).fillColor("#52627B").text(`Сертификат: ${signer.certificateSerial || "не указан"}`);
    doc.text("Криптографическая проверка и проверка сертификата пройдены при приёме подписи.");
  }
  doc.moveDown(1.5).font("bold").fontSize(10).fillColor("#17243B").text("SHA-256 исходного документа");
  doc.font("regular").fontSize(8).text(receipt.documentHash);
  // Keep the QR and its caption together even with long party names.
  if (doc.y > 620) doc.addPage();
  doc.moveDown();
  const y = doc.y;
  const qr = await QRCode.toBuffer(receipt.verificationUrl, { width: 360, margin: 4, errorCorrectionLevel: "M" });
  doc.image(qr, 48, y, { width: 105 });
  doc.font("bold").fontSize(11).text("Проверка подписания", 170, y + 10, { width: 370 });
  doc.font("regular").fontSize(9).fillColor("#1765B5").text(receipt.verificationUrl, { width: 370, link: receipt.verificationUrl });
  doc.fillColor("#52627B").fontSize(9).text("QR-код ведёт на страницу сведений о подписях в BasQar.", { width: 370 });
  doc.x = 48; doc.y = Math.max(doc.y + 16, y + 120);
  doc.fontSize(9).text("Лист создан BasQar на основании сохранённых результатов проверки. Он не заменяет ЭЦП. Для независимой проверки используйте неизменённый оригинал и файлы подписей из архива или вложений этого PDF.", { width: 499 });
  doc.end();
  return result;
}

export async function buildSignedContractExport(prisma: PrismaClient, tenantId: string, contractId: string, format: "pdf" | "zip") {
  const contract = await prisma.contract.findFirst({ where: { id: contractId, tenantId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  const version = contract.versions[0];
  if (contract.status !== "SIGNED" || !version?.fileId || !version.sha256 || !contract.verificationPublicId) {
    throw new ApiError(409, "both_signatures_required", "Скачивание доступно после проверенных подписей обеих сторон.");
  }
  const signatures = await prisma.documentSignature.findMany({
    where: { tenantId, contractId, contractVersionId: version.id, documentHash: version.sha256, verificationStatus: "VERIFIED",
      request: { status: "SIGNED", contractVersionId: version.id, contractId } },
    include: { request: true }, orderBy: { signedAt: "asc" },
  });
  const selected = ["SELLER", "BUYER"].map(role => signatures.find(row => row.request?.signerType === role &&
    (row.verificationDetails as Record<string, unknown>)?.authority === "VALID" &&
    (row.verificationDetails as Record<string, unknown>)?.crypto === "kalkan_cms_verified"));
  if (selected.some(row => !row)) throw new ApiError(409, "both_signatures_required", "Не найдены проверенные подписи обеих сторон этой версии договора.");
  const readChecked = async (id: string | null, expectedHash?: string) => {
    const attachment = id ? await prisma.attachment.findFirst({ where: { id, tenantId } }) : null;
    if (!attachment?.checksum) throw new ApiError(409, "signed_file_missing", "Не найден оригинал или файл ЭЦП. Обратитесь к администратору.");
    const bytes = await readFile(resolveUploadPath(attachment.storageKey)).catch(() => { throw new ApiError(409, "signed_file_missing", "Не найден оригинал или файл ЭЦП. Обратитесь к администратору."); });
    if (hash(bytes) !== (expectedHash || attachment.checksum)) throw new ApiError(409, "signed_file_changed", "Нарушена целостность оригинала или ЭЦП. Скачивание остановлено.");
    return bytes;
  };
  const original = await readChecked(version.fileId, version.sha256);
  if (original.subarray(0, 5).toString() !== "%PDF-") throw new ApiError(409, "signed_pdf_unavailable", "Подписанный оригинал не является PDF. Обратитесь к администратору для выгрузки этой версии.");
  const files = await Promise.all(selected.map(row => readChecked(row!.signatureFileId)));
  const receipt: SigningReceipt = {
    number: contract.number, version: version.version, documentHash: version.sha256,
    verificationUrl: `${config.appBaseUrl.replace(/\/$/, "")}/verify/${contract.verificationPublicId}`,
    signers: selected.map((row, index) => ({ organization: (() => {
      const pem = inspectCms(files[index].toString("base64")).primaryPem;
      return pem ? new X509Certificate(pem).subject.match(/(?:^|\n)O=(.*)(?:\n|$)/)?.[1] || null : null;
    })(), role: row!.request!.signerType, name: row!.signerName || "Не указан", bin: row!.signerBin,
      iin: mask(row!.signerIin), signedAt: row!.signedAt.toISOString(), certificateSerial: row!.certificateSerial })),
  };
  return buildSignedDocumentExport(original, files, receipt, format);
}

/** Shared archive format for contracts and AVR; original and signatures stay byte-identical. */
export async function buildSignedDocumentExport(original: Buffer, files: Buffer[], receipt: SigningReceipt, format: "pdf" | "zip") {
  const sheet = await renderSigningReceipt(receipt);
  const pdf = await PDFDocument.create();
  const source = await PDFDocument.load(original);
  for (const page of await pdf.copyPages(source, source.getPageIndices())) pdf.addPage(page);
  const sheetPdf = await PDFDocument.load(sheet);
  for (const page of await pdf.copyPages(sheetPdf, sheetPdf.getPageIndices())) pdf.addPage(page);
  const entries: Array<[string, Buffer, string]> = [
    ["original.pdf", original, "application/pdf"], ["seller.p7s", files[0], "application/pkcs7-signature"], ["buyer.p7s", files[1], "application/pkcs7-signature"],
  ];
  for (const [name, bytes, mimeType] of entries) await pdf.attach(bytes, name, { mimeType });
  pdf.setTitle(`${receipt.documentLabel || "Договор"} ${receipt.number} - подписан обеими сторонами`);
  const annotated = Buffer.from(await pdf.save());
  const safeNumber = receipt.number.replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 100) || "contract";
  if (format === "pdf") return { bytes: annotated, name: `${safeNumber}-signed.pdf`, mime: "application/pdf" };
  const zip = new JSZip();
  for (const [name, bytes] of entries) zip.file(name, bytes);
  zip.file("signed-view.pdf", annotated);
  zip.file("signing-receipt.pdf", sheet);
  zip.file("verification.json", JSON.stringify({ ...receipt, verificationBasis: "stored checks at signature acceptance", files: entries.map(([name, bytes]) => ({ name, sha256: hash(bytes) })) }, null, 2));
  zip.file("README.txt", "BasQar: документ подписан обеими сторонами.\n\noriginal.pdf - неизменённый подписанный оригинал.\nseller.p7s / buyer.p7s - отсоединённые CMS-подписи исполнителя и заказчика. Проверяйте каждую подпись совместно с original.pdf.\nsigned-view.pdf - копия для просмотра с листом подписания и вложенными оригиналом и ЭЦП.\nsigning-receipt.pdf - лист подписания.\nverification.json - сведения и контрольные суммы.\n\nPDF с отметками и протокол не заменяют криптографическую проверку. Даты - время приёма подписи в BasQar, не независимая метка времени НУЦ.\n");
  return { bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), name: `${safeNumber}-signatures.zip`, mime: "application/zip" };
}

export function sendSignedExport(res: Response, file: { bytes: Buffer; name: string; mime: string }) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.send(file.bytes);
}
