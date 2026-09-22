import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { googleRequest } from "./googleConnectionService.ts";
import { processTrustedIntegrationLead } from "./inquiryService.ts";
import { recordExternalMessage } from "./externalMessageService.ts";
import { assertConversationMime, CONVERSATION_MAX_FILE_BYTES } from "./conversationMedia.ts";

type Integration = Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>;
async function readGoogle<T>(prisma: PrismaClient, row: Integration, path: string): Promise<T> {
  const response = await googleRequest(prisma, row, path);
  if (!response.ok) throw new ApiError(502, "google_read_failed", `Не удалось прочитать данные Google (${response.status}). Проверьте доступ аккаунта.`);
  return await response.json() as T;
}
export function mapFormAnswers(questions: Array<{ id: string; title: string }>, answers: Record<string, { textAnswers?: { answers?: Array<{ value?: string }> } }>, mapping: { phone?: string; name?: string; email?: string; message?: string } = {}) {
  const fields: Record<string,string> = {};
  for (const question of questions) fields[question.id] = (answers[question.id]?.textAnswers?.answers || []).map(a => a.value || "").join(", ");
  const pick = (field: keyof typeof mapping, pattern: RegExp) => fields[mapping[field] || questions.find(q => pattern.test(q.title))?.id || ""] || "";
  return { phone: pick("phone", /телефон|phone|мобильн|whatsapp/i), name: pick("name", /^(имя|фио|ф\.и\.о\.?|name|full.?name|ваше имя)$/i), email: pick("email", /email|e-mail|почт/i), message: pick("message", /сообщен|комментар|message|comment|вопрос/i), fields };
}
export async function googleFormQuestions(prisma: PrismaClient, row: Integration) {
  const resourceId = (row.schemaJson as { resourceId: string }).resourceId;
  const form = await readGoogle<{ items?: Array<{ title?: string; questionItem?: { question?: { questionId?: string } } }> }>(prisma, row, `/v1/forms/${encodeURIComponent(resourceId)}`);
  return (form.items || []).flatMap(item => item.questionItem?.question?.questionId ? [{ id: item.questionItem.question.questionId, title: item.title || item.questionItem.question.questionId }] : []);
}
async function syncForms(prisma: PrismaClient, row: Integration) {
  const settings = row.schemaJson as { resourceId: string; connectedAt: string; lastSyncAt?: string };
  const questions = await googleFormQuestions(prisma, row);
  const startedAt = new Date().toISOString();
  const since = new Date(Math.max(new Date(settings.connectedAt).getTime(), new Date(settings.lastSyncAt || settings.connectedAt).getTime() - 300000)).toISOString();
  const params = new URLSearchParams({ pageSize: "100", filter: `timestamp >= ${since}` });
  let pageToken = "", count = 0;
  do {
    if (pageToken) params.set("pageToken", pageToken);
    const page = await readGoogle<{ responses?: Array<{ responseId: string; lastSubmittedTime: string; respondentEmail?: string; answers?: Record<string, { textAnswers?: { answers?: Array<{ value?: string }> } }> }>; nextPageToken?: string }>(prisma, row, `/v1/forms/${encodeURIComponent(settings.resourceId)}/responses?${params}`);
    for (const response of page.responses || []) {
      const mapped = mapFormAnswers(questions, response.answers || {}, row.mappingJson as Record<string,string>);
      const eventId = `google-form:${createHash("sha256").update(`${settings.resourceId}:${response.responseId}`).digest("hex")}`;
      const duplicate = await prisma.inboundEvent.findUnique({ where: { integrationId_externalEventKey: { integrationId: row.id, externalEventKey: eventId } } });
      if (duplicate) continue;
      await processTrustedIntegrationLead(prisma, row, { event_id: eventId, event_type: "inquiry.created", occurred_at: response.lastSubmittedTime,
        contact: { name: mapped.name, methods: [{ type: "phone", value: mapped.phone }, { type: "email", value: mapped.email || response.respondentEmail || "" }] },
        inquiry: { subject: "Заявка Google Forms", message: mapped.message || questions.map(q => `${q.title}: ${mapped.fields[q.id]}`).join("\n"), custom_fields: mapped.fields }, attribution: { source: "google_forms" } });
      count++;
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  await prisma.integration.updateMany({ where: { id: row.id, status: "active", credentialId: row.credentialId }, data: { schemaJson: { ...settings, lastSyncAt: startedAt } } });
  return { imported: count };
}

type GmailPart = { mimeType?: string; filename?: string; headers?: Array<{ name: string; value: string }>; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GmailPart[] };
function flattenParts(part: GmailPart): GmailPart[] { return [part, ...(part.parts || []).flatMap(flattenParts)]; }
export function gmailPlainText(payload: GmailPart, snippet: string) {
  const plain = flattenParts(payload).filter(part => part.mimeType === "text/plain" && !part.filename && part.body?.data).map(part => Buffer.from(part.body!.data!, "base64url").toString("utf8")).join("\n");
  // HTML is never rendered as trusted markup in the CRM.
  return (plain || snippet || "[Письмо без текстового содержимого]").slice(0,100000);
}
async function syncGmail(prisma: PrismaClient, row: Integration) {
  const settings = row.schemaJson as { connectedAt: string; resourceLabel?: string; lastSyncAt?: string };
  const startedAt = new Date().toISOString();
  // Overlap protects delayed indexing; database message IDs prevent repeated imports.
  const after = Math.floor(new Date(settings.lastSyncAt || settings.connectedAt).getTime()/1000) - 86400;
  const params = new URLSearchParams({ maxResults: "100", q: `in:inbox after:${after}`, includeSpamTrash: "false" });
  let pageToken = "", count = 0;
  do {
    if (pageToken) params.set("pageToken", pageToken);
    const page = await readGoogle<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(prisma, row, `/gmail/v1/users/me/messages?${params}`);
    for (const brief of page.messages || []) {
      const eventId = `gmail:${brief.id}`;
      if (await prisma.inboundEvent.findUnique({ where: { integrationId_externalEventKey: { integrationId: row.id, externalEventKey: eventId } } })) continue;
      const message = await readGoogle<{ id: string; threadId: string; internalDate: string; snippet?: string; payload: GmailPart }>(prisma, row, `/gmail/v1/users/me/messages/${encodeURIComponent(brief.id)}?format=full`);
      if (Number(message.internalDate) < new Date(settings.connectedAt).getTime()) continue;
      const headers = message.payload.headers || [];
      const header = (key: string) => headers.find(h => h.name.toLowerCase() === key)?.value || "";
      const from = header("from"); const email = (from.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || from.match(/[^\s<>]+@[^\s<>]+/)?.[0] || "").toLowerCase();
      const attachments: Array<{ fileName: string; mimeType: string; buffer: Buffer }> = [];
      const skipped: string[] = [];
      for (const part of flattenParts(message.payload).filter(p => p.filename)) {
        if ((part.body?.size || 0) > CONVERSATION_MAX_FILE_BYTES || attachments.length >= 5) { skipped.push(part.filename!); continue; }
        let mimeType: string;
        try { mimeType = assertConversationMime(part.filename!, part.mimeType || "application/octet-stream"); } catch { skipped.push(part.filename!); continue; }
        const data = part.body?.data || (part.body?.attachmentId ? (await readGoogle<{ data: string }>(prisma, row, `/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)).data : "");
        const buffer = Buffer.from(data, "base64url");
        if (buffer.length > CONVERSATION_MAX_FILE_BYTES) { skipped.push(part.filename!); continue; }
        attachments.push({ fileName: part.filename!, mimeType, buffer });
      }
      await recordExternalMessage(prisma, row.id, { eventId, channel: "email", externalUserId: email || `unknown:${message.id}`, threadId: message.threadId, messageId: message.id,
        name: from.replace(/<[^>]+>/g, "").replace(/^"|"$/g, "").trim() || email || "Отправитель письма", email: email || undefined,
        text: [header("subject"), gmailPlainText(message.payload, message.snippet || ""), skipped.length ? `Вложения остались в Gmail (ограничения CRM): ${skipped.join(", ")}` : ""].filter(Boolean).join("\n\n"), at: new Date(Number(message.internalDate)), raw: { id: message.id, threadId: message.threadId, from, subject: header("subject") }, attachments });
      count++;
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  await prisma.integration.updateMany({ where: { id: row.id, status: "active", credentialId: row.credentialId }, data: { schemaJson: { ...settings, lastSyncAt: startedAt } } });
  return { imported: count };
}
export async function syncGoogleIntake(prisma: PrismaClient, row: Integration) {
  if (row.type === "google_forms") return syncForms(prisma, row);
  if (row.type === "email") return syncGmail(prisma, row);
  throw new ApiError(422, "unsupported_google_type", "Неизвестный тип подключения");
}
