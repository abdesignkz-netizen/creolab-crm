import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import type { AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess, requireTenant } from "../lib/access.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { ApiError } from "../errors.ts";
import { DOCX_MIME, isDocxBytes } from "./contractDocx.ts";
import { convertDocToDocx, DOC_MAGIC, docxToText } from "./wordDocumentText.ts";

export async function sendContractWord(prisma: PrismaClient, auth: AuthContext, id: string, res: Response, preview = false) {
  requireDocumentsAccess(auth);
  const tenantId = requireTenant(auth).tenantId;
  const contract = preview ? null : await prisma.contract.findFirst({ where: { id, tenantId } });
  const previewFile = preview ? await prisma.attachment.findFirst({ where: { id, tenantId, parentType: { in: ["contract_preview", "contract"] } } }) : null;
  if (preview ? !previewFile : !contract) throw new ApiError(404, "not_found", "Договор не найден");
  const current = previewFile || await prisma.attachment.findFirst({ where: { id: contract!.originalFileId || contract!.generatedFileId || "", tenantId } });
  const source = current && (/wordprocessingml|msword/i.test(current.mimeType) || /\.docx?$/i.test(current.fileName)) ? current
    : contract?.originalFileId ? null : await prisma.attachment.findFirst({
      where: { tenantId, parentType: previewFile?.parentType || "contract", parentId: previewFile?.parentId || id, documentType: "contract_source" },
      orderBy: { createdAt: "desc" },
    });
  if (!source) throw new ApiError(422, "word_not_available", "Для этого договора не сохранён исходный Word-файл. Доступно скачивание PDF.");
  let bytes = await readFile(resolveUploadPath(source.storageKey)).catch(() => { throw new ApiError(404, "not_found", "Word-файл договора не найден на диске"); });
  if (bytes.subarray(0, 8).equals(DOC_MAGIC)) {
    const converted = await convertDocToDocx(bytes);
    if (!converted) throw new ApiError(422, "word_conversion_unavailable", "Не удалось преобразовать старый Word-файл в DOCX. Повторите скачивание позже.");
    bytes = Buffer.from(converted);
  }
  if (!isDocxBytes(bytes)) throw new ApiError(422, "word_invalid", "Исходный файл не является документом Word.");
  await docxToText(bytes);
  const name = `${(contract?.number || previewFile!.fileName).replace(/\.(pdf|docx?)$/i, "")}.docx`;
  res.setHeader("Content-Type", DOCX_MIME);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(bytes);
}
