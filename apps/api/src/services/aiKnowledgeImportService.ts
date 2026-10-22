import path from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AI_KNOWLEDGE_FILE_BYTES, type AiKnowledgeImportPreview, type AiKnowledgeCategory } from "@creolab/contracts";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireAiSettingsAccess, requireConfigurationTenant } from "../lib/access.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { writeAudit } from "../lib/audit.ts";
import { downloadPublicMedia, publicMediaUrl } from "../lib/publicMedia.ts";
import { beginDocumentExtraction } from "./documentExtractionGate.ts";
import { extractKnowledgeWebsite } from "./knowledgeWebsiteText.ts";
import { checkKnowledgeText, type KnowledgeFileText } from "./knowledgeFileText.ts";
import { ensureKnowledgeImportMemory } from "./knowledgeImportResources.ts";

const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), fileName: z.string().trim().min(1).max(300), fileBase64: z.string().min(1).max(Math.ceil(AI_KNOWLEDGE_FILE_BYTES / 3) * 4) }).strict(),
  z.object({ kind: z.literal("url"), url: z.string().trim().min(1).max(2000) }).strict(),
]);
export function suggestedKnowledgeCategory(title: string, content: string): AiKnowledgeCategory {
  const hint = `${title}\n${content.slice(0, 400)}`.toLowerCase();
  if (/прайс|цены|стоимость|price|баға/.test(hint)) return "prices";
  if (/доставк|оплат|гаранти|возврат|payment|delivery|жеткізу/.test(hint)) return "terms";
  if (/faq|вопросы|сұрақ|questions/.test(hint)) return "faq";
  if (/каталог|товары|услуги|products|services|қызмет|тауар/.test(hint)) return "offerings";
  if (/о компании|о нас|about|компания туралы/.test(hint)) return "company";
  return "other";
}

/** Hard deadline and a separate V8 heap keep document parsing off the API event loop. */
export async function extractKnowledgeFileIsolated(fileName: string, bytes: Buffer, timeoutMs = 90_000): Promise<KnowledgeFileText> {
  const extension = path.extname(fileName).toLowerCase();
  ensureKnowledgeImportMemory([".png", ".jpg", ".jpeg"].includes(extension) ? "image" : [".txt", ".md"].includes(extension) ? "text" : "document");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "basqar-knowledge-"));
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./knowledgeFileWorker.ts", import.meta.url), {
      workerData: { fileName, bytes, temporaryRoot }, execArgv: ["--experimental-strip-types"], resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    return await new Promise<KnowledgeFileText>((resolve, reject) => {
      timer = setTimeout(() => reject(new ApiError(422, "knowledge_import_timeout", "Распознавание заняло слишком много времени. Разделите документ на части или загрузите более чёткие страницы.")), timeoutMs);
      worker!.once("message", message => message.error
        ? reject(new ApiError(message.error.status, message.error.code, message.error.message)) : resolve(message.result));
      worker!.once("error", () => reject(new ApiError(422, "knowledge_file_complex", "Не удалось обработать материал. Уменьшите размер или разделите его на части.")));
      worker!.once("exit", () => reject(new ApiError(422, "knowledge_import_failed", "Обработка прервана. Повторите загрузку или разделите файл на части.")));
    });
  } finally {
    clearTimeout(timer);
    try { await worker?.terminate(); }
    finally { await rm(temporaryRoot, { recursive: true, force: true }); }
  }
}

type Downloader = typeof downloadPublicMedia;
export async function previewAiKnowledgeImport(prisma: PrismaClient, auth: AuthContext, raw: unknown, download: Downloader = downloadPublicMedia): Promise<AiKnowledgeImportPreview> {
  requireAiSettingsAccess(auth);
  const { tenantId } = requireConfigurationTenant(auth);
  rateLimit(`ai-knowledge-import:${tenantId}:${auth.user.id}`, 12, 60_000);
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, "knowledge_import_input", "Выберите файл до 10 МБ или укажите ссылку на публичную страницу HTTPS.");
  const input = parsed.data;
  const release = beginDocumentExtraction();
  try {
    let title = "", name = "", url: string | undefined;
    let extracted: KnowledgeFileText;
    let links: AiKnowledgeImportPreview["links"] = [];
    if (input.kind === "file") {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.fileBase64) || input.fileBase64.length % 4 !== 0) throw new ApiError(422, "knowledge_file_invalid", "Не удалось прочитать файл. Выберите его повторно.");
      name = path.basename(input.fileName.replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "");
      title = name.replace(/\.[^.]+$/, "");
      const bytes = Buffer.from(input.fileBase64, "base64");
      if (!bytes.length || bytes.length > AI_KNOWLEDGE_FILE_BYTES) throw new ApiError(422, "knowledge_file_size", "Выберите непустой файл размером до 10 МБ.");
      extracted = await extractKnowledgeFileIsolated(name, bytes);
    } else {
      try { url = publicMediaUrl(input.url).href; } catch { throw new ApiError(422, "knowledge_url_invalid", "Укажите публичную ссылку HTTPS без логина и пароля. Локальные адреса недоступны."); }
      let response: Awaited<ReturnType<Downloader>>;
      const signal = AbortSignal.timeout(20_000);
      try {
        response = await Promise.race([
          download(url, 2_000_000, 0, signal),
          new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("page_timeout")), { once: true })),
        ]);
      } catch {
        throw new ApiError(422, "knowledge_url_unavailable", "Страница недоступна для чтения: сайт может требовать вход или запрещать загрузку. Откройте другую публичную страницу, загрузите файл или вставьте текст.");
      }
      url = publicMediaUrl(response.url || url).href;
      if (!/^text\/(?:html|plain)\b|^application\/xhtml\+xml\b/i.test(response.contentType)) throw new ApiError(422, "knowledge_url_type", "По ссылке нет текстовой веб-страницы. Скачайте документ и добавьте его через «Загрузить материалы».");
      const charset = response.contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || "utf-8";
      let body: string;
      try { body = new TextDecoder(charset, { fatal: true }).decode(response.buffer); }
      catch { throw new ApiError(422, "knowledge_page_encoding", "Не удалось прочитать кодировку страницы. Загрузите документ или вставьте текст вручную."); }
      const page = /^text\/plain\b/i.test(response.contentType) ? { title: new URL(url).hostname, content: body, links: [] } : extractKnowledgeWebsite(body, url);
      title = name = page.title; links = page.links;
      extracted = { content: checkKnowledgeText(page.content), ocr: false, pages: 1, warnings: ["Импортирован текст только этой страницы. Проверьте полноту сведений; другие страницы можно выбрать ниже. Обновления сайта не публикуются автоматически."] };
    }
    await writeAudit(prisma, { tenantId, actorUserId: auth.user.id, action: "AI_KNOWLEDGE_IMPORT_PREVIEWED", entityType: "ai_configuration", changes: { kind: input.kind, characters: extracted.content.length, pages: extracted.pages, ocr: extracted.ocr } });
    return { title: title || name, content: extracted.content, category: suggestedKnowledgeCategory(title, extracted.content),
      source: { kind: input.kind, name, ...(url ? { url } : {}), importedAt: new Date().toISOString(), fingerprint: createHash("sha256").update(extracted.content).digest("hex"), ocr: extracted.ocr },
      warnings: extracted.warnings, pages: extracted.pages, links };
  } finally { release(); }
}
