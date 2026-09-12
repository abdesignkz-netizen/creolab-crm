import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { createContractDraft, createElectronicDocumentDraft, createInvoiceDraft } from "./documentDraftService.ts";
import { generateContractPdfFile } from "./contractGenerationService.ts";
import { generateInvoicePdfFile } from "./invoiceGenerationService.ts";
import { sendContractForSign } from "./contractSigningService.ts";
import { validateAvr } from "./avrService.ts";
import { validateEsfInvoice } from "./esfInvoiceService.ts";
import { sendAvrEsf } from "./esfPocService.ts";
import { getDealCloseReadiness } from "./dealCloseReadiness.ts";
import { markDealWon } from "./dealService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";

export const DOCUMENT_ACTIONS = [
  "generate_contract",
  "send_for_sign",
  "generate_invoice",
  "create_avr",
  "validate_avr",
  "send_avr",
  "create_esf",
  "validate_esf",
  "send_esf",
  "close_deal",
] as const;

export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

export const DOCUMENT_ACTION_LABEL: Record<DocumentAction, string> = {
  generate_contract: "Сформировать договор",
  send_for_sign: "Отправить договор на подпись",
  generate_invoice: "Сформировать счёт",
  create_avr: "Подготовить АВР",
  validate_avr: "Проверить АВР",
  send_avr: "Отправить АВР в ИС ЭСФ",
  create_esf: "Подготовить ЭСФ",
  validate_esf: "Проверить ЭСФ",
  send_esf: "Отправить ЭСФ в ИС ЭСФ",
  close_deal: "Закрыть сделку",
};

function normalize(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function has(text: string, re: RegExp) {
  return re.test(text);
}

export function detectDocumentCommand(rawText: string) {
  const text = normalize(rawText);
  const prepareOnly = /подготов(ь|ьте|ить)|черновик|не отправля|только подготов/.test(text);

  if (has(text, /закрой\s+сделк|отметь\s+(сделк\w*\s+)?(выигран|won)|сделк\w*\s+в\s+won/)) {
    return { action: "close_deal" as const, prepareOnly: false };
  }
  if (
    (has(text, /отправ(ь|ьте|ить).{0,40}эсф/) || has(text, /эсф.{0,20}в\s+ис\s+эсф/)) &&
    !has(text, /авр|awp/)
  ) {
    return { action: "send_esf" as const, prepareOnly };
  }
  if (has(text, /проверь.{0,20}эсф|валидир.{0,20}эсф/)) {
    return { action: "validate_esf" as const, prepareOnly: false };
  }
  if (has(text, /(создай|сформируй|подготовь).{0,20}эсф/)) {
    return { action: "create_esf" as const, prepareOnly };
  }
  if (has(text, /отправ(ь|ьте|ить).{0,40}(авр|awp)/) || has(text, /(авр|акт).{0,20}в\s+ис\s+эсф/)) {
    return { action: "send_avr" as const, prepareOnly };
  }
  if (has(text, /проверь.{0,20}(авр|акт)|валидир.{0,20}(авр|акт)/)) {
    return { action: "validate_avr" as const, prepareOnly: false };
  }
  if (has(text, /(создай|сформируй|подготовь).{0,20}(авр|акт выполн)/)) {
    return { action: "create_avr" as const, prepareOnly };
  }
  if (has(text, /(сформируй|создай|выставь|подготовь).{0,24}сч[её]т/)) {
    return { action: "generate_invoice" as const, prepareOnly };
  }
  if (has(text, /отправ(ь|ьте|ить).{0,40}договор.{0,20}(на подпись|подписать)/)) {
    return { action: "send_for_sign" as const, prepareOnly: false };
  }
  if (has(text, /(сформируй|создай|подготовь|сделай).{0,24}договор/)) {
    return { action: "generate_contract" as const, prepareOnly };
  }
  return null;
}

export function extractDealTitleQuery(rawText: string) {
  const text = rawText.trim();
  const quoted = text.match(/сделк[аеиу]\s*[«"]([^»"]+)[»"]/i);
  if (quoted?.[1]) return quoted[1].trim();
  const by = text.match(/по сделке\s+(.+)$/i);
  if (by?.[1]) return by[1].replace(/[.?!]+$/, "").trim();
  return "";
}

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

export async function resolveDocumentDeals(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { text: string; dealId?: string; contactIds?: string[]; clientNameQuery?: string | null },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const dealId = String(input.dealId || "").trim();
  if (dealId) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, tenantId: tid },
      select: { id: true, title: true, outcome: true, contactId: true, companyId: true },
    });
    return deal ? [deal] : [];
  }

  const title = extractDealTitleQuery(input.text);
  const contactIds = [...new Set(input.contactIds || [])];
  if (!contactIds.length && input.clientNameQuery) {
    const contacts = await prisma.contact.findMany({
      where: {
        tenantId: tid,
        archivedAt: null,
        OR: [
          { name: { contains: input.clientNameQuery, mode: "insensitive" } },
          { firstName: { contains: input.clientNameQuery, mode: "insensitive" } },
          { lastName: { contains: input.clientNameQuery, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 8,
    });
    contactIds.push(...contacts.map((row) => row.id));
  }

  return prisma.deal.findMany({
    where: {
      tenantId: tid,
      outcome: "open",
      ...(title ? { title: { contains: title, mode: "insensitive" } } : {}),
      ...(contactIds.length ? { contactId: { in: contactIds } } : {}),
    },
    select: { id: true, title: true, outcome: true, contactId: true, companyId: true },
    orderBy: { updatedAt: "desc" },
    take: title || contactIds.length ? 8 : 5,
  });
}

async function latestEdoc(prisma: PrismaClient, tenantId: string, dealId: string, type: "AVR" | "ESF") {
  return prisma.electronicDocument.findFirst({
    where: { tenantId, dealId, type },
    orderBy: { createdAt: "desc" },
  });
}

export async function executeDocumentCommand(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { text: string; action?: string; dealId?: string; publicBaseUrl?: string },
) {
  const membership = requireTenant(auth);
  const detected = detectDocumentCommand(input.text);
  const action = (input.action || detected?.action || "") as DocumentAction;
  if (!DOCUMENT_ACTIONS.includes(action)) {
    throw new ApiError(422, "unknown_document_command", "Не понял команду по документам");
  }
  if (action !== "close_deal" && !can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
  await requireDocumentsEnabled(prisma, membership.tenantId);
  const prepareOnly = Boolean(detected?.prepareOnly);

  const deals = await resolveDocumentDeals(prisma, auth, {
    text: input.text,
    dealId: input.dealId,
  });
  if (!deals.length) throw new ApiError(422, "deal_required", "Укажите сделку для документа");
  if (deals.length > 1 && !input.dealId) {
    throw new ApiError(422, "ambiguous_deal", "Найдено несколько сделок — выберите одну", undefined, {
      deals: deals.map((row) => ({ id: row.id, title: row.title, href: `/deals/${row.id}` })),
    });
  }
  const deal = deals[0]!;

  if (action === "generate_contract") {
    const draft = await createContractDraft(prisma, auth, deal.id, {});
    if (prepareOnly) return { action, prepareOnly, deal, result: draft };
    return { action, prepareOnly: false, deal, result: await generateContractPdfFile(prisma, auth, draft.contract.id) };
  }
  if (action === "send_for_sign") {
    const contract = await prisma.contract.findFirst({
      where: { tenantId: membership.tenantId, dealId: deal.id },
      orderBy: { createdAt: "desc" },
    });
    if (!contract) throw new ApiError(422, "contract_required", "Сначала сформируйте договор");
    return {
      action,
      prepareOnly: false,
      deal,
      result: await sendContractForSign(prisma, auth, contract.id, {
        publicBaseUrl: input.publicBaseUrl || "http://127.0.0.1:4191",
      }),
    };
  }
  if (action === "generate_invoice") {
    const draft = await createInvoiceDraft(prisma, auth, deal.id, {});
    if (prepareOnly) return { action, prepareOnly, deal, result: draft };
    return { action, prepareOnly: false, deal, result: await generateInvoicePdfFile(prisma, auth, draft.invoice.id) };
  }
  if (action === "create_avr" || action === "validate_avr" || action === "send_avr") {
    let document = await latestEdoc(prisma, membership.tenantId, deal.id, "AVR");
    if (!document || action === "create_avr") {
      const created = await createElectronicDocumentDraft(prisma, auth, deal.id, { type: "AVR" });
      document = await prisma.electronicDocument.findFirstOrThrow({ where: { id: created.document.id } });
      if (action === "create_avr" && prepareOnly) return { action, prepareOnly, deal, result: created };
    }
    if (action === "create_avr") {
      return { action, prepareOnly: false, deal, result: await validateAvr(prisma, auth, document.id) };
    }
    if (action === "validate_avr") return { action, prepareOnly: false, deal, result: await validateAvr(prisma, auth, document.id) };
    return { action, prepareOnly: false, deal, result: await sendAvrEsf(prisma, auth, document.id) };
  }
  if (action === "create_esf" || action === "validate_esf" || action === "send_esf") {
    let document = await latestEdoc(prisma, membership.tenantId, deal.id, "ESF");
    if (!document || action === "create_esf") {
      const created = await createElectronicDocumentDraft(prisma, auth, deal.id, { type: "ESF" });
      document = await prisma.electronicDocument.findFirstOrThrow({ where: { id: created.document.id } });
      if (action === "create_esf" && prepareOnly) return { action, prepareOnly, deal, result: created };
    }
    if (action === "create_esf") {
      return { action, prepareOnly: false, deal, result: await validateEsfInvoice(prisma, auth, document.id) };
    }
    if (action === "validate_esf") {
      return { action, prepareOnly: false, deal, result: await validateEsfInvoice(prisma, auth, document.id) };
    }
    return { action, prepareOnly: false, deal, result: await sendAvrEsf(prisma, auth, document.id) };
  }

  const readiness = await getDealCloseReadiness(prisma, auth, deal.id);
  if (!readiness.ready) {
    throw new ApiError(422, "deal_not_ready", "Сделку ещё рано закрывать", undefined, readiness);
  }
  return {
    action,
    prepareOnly: false,
    deal,
    result: await markDealWon(prisma, auth, deal.id, {}),
  };
}
