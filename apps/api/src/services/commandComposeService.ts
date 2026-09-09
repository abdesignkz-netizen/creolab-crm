import type { PrismaClient } from "@creolab/db";
import {
  acceptPersonalizedDraft,
  clientAskFromStaffTask,
  clientFacingAskFromTask,
  composeRecipientOffer,
  inferCampaignOfferKind,
  looksLikeStaffCommand,
  pickPersonFirstName,
} from "./campaignPersonalize.ts";
import { inquiryInterest, loadConversationInterests, pickUsableInterest } from "./contactInterestService.ts";
import { composeClientMessageWithLlm, refineCampaignRecipientDraftsWithLlm } from "./llmClient.ts";

export type ContactComposeFact = {
  contactId: string;
  firstName: string | null;
  companyName: string | null;
  interest: string | null;
  lastClientMessage: string | null;
  history: Array<{ role: "user" | "assistant"; content: string }>;
};

const CLIENT_TEXT_TYPES = new Set(["message", "proposal", "send_documents", "follow_up", "other"]);

export function wantsClientMessageDraft(taskType?: string | null) {
  const type = String(taskType || "");
  return !type || CLIENT_TEXT_TYPES.has(type);
}

export function isGenericTemplateDraft(text: string) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/созвон|звонк|удобн\w*\s+врем|оплат|встреч|файл готов|макет|согласован/i.test(t)) return false;
  return /хотел уточнить по (вашей заявке|нашему вопросу)|актуальна ли ещё( ваша)? заявка|актуален ли ещё запрос/i.test(t);
}

function keepUserDraft(draft: string) {
  const text = String(draft || "").trim();
  if (!text) return false;
  if (looksLikeStaffCommand(text) || isGenericTemplateDraft(text)) return false;
  return true;
}

export async function loadContactComposeFacts(
  prisma: PrismaClient,
  tenantId: string,
  contactIds: string[],
): Promise<ContactComposeFact[]> {
  const ids = [...new Set(contactIds.filter(Boolean))].slice(0, 30);
  if (!ids.length) return [];

  const contacts = await prisma.contact.findMany({
    where: { tenantId, id: { in: ids } },
    select: {
      id: true,
      name: true,
      firstName: true,
      companyName: true,
      inquiries: {
        where: { archived: false },
        orderBy: { receivedAt: "desc" },
        take: 1,
        select: { subject: true, service: true },
      },
    },
  });
  const contactMap = new Map(contacts.map((row) => [row.id, row]));
  const conversationInterests = await loadConversationInterests(prisma, tenantId, ids);
  const conversations = await prisma.conversation.findMany({
    where: { tenantId, contactId: { in: ids } },
    select: {
      contactId: true,
      updatedAt: true,
      messages: {
        where: { tenantId, internal: false, text: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 16,
        select: { text: true, direction: true, senderKind: true, createdAt: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const historyByContact = new Map<string, ContactComposeFact["history"]>();
  const lastClientByContact = new Map<string, string>();
  for (const conversation of conversations) {
    if (!conversation.contactId || historyByContact.has(conversation.contactId)) continue;
    const chronological = [...conversation.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    historyByContact.set(
      conversation.contactId,
      chronological.map((message) => ({
        role: message.direction === "inbound" || message.senderKind === "client" ? "user" : "assistant",
        content: String(message.text || "").trim(),
      })).filter((item) => item.content),
    );
    const lastInbound = conversation.messages.find(
      (message) => message.direction === "inbound" || message.senderKind === "client",
    );
    if (lastInbound?.text) lastClientByContact.set(conversation.contactId, lastInbound.text.trim());
  }

  return ids.map((contactId) => {
    const contact = contactMap.get(contactId);
    const inquiry = contact?.inquiries[0];
    return {
      contactId,
      firstName: pickPersonFirstName(contact?.firstName, contact?.name),
      companyName: contact?.companyName || null,
      interest: pickUsableInterest(
        conversationInterests.get(contactId)?.text,
        inquiry?.service,
        inquiry?.subject,
        inquiryInterest(inquiry)?.text,
      ),
      lastClientMessage: lastClientByContact.get(contactId) || null,
      history: historyByContact.get(contactId) || [],
    };
  });
}

export function composeDeterministicClientDraft(input: {
  taskText: string;
  sharedDraft?: string | null;
  firstName?: string | null;
  companyName?: string | null;
  interest?: string | null;
  hasFile?: boolean;
}) {
  return composeRecipientOffer({
    taskText: input.taskText,
    sharedDraft: input.sharedDraft,
    firstName: input.firstName,
    companyName: input.companyName,
    interest: input.interest,
    hasFile: input.hasFile,
  });
}

export async function composeCommandClientDraft(input: {
  prisma: PrismaClient;
  tenantId: string;
  taskText: string;
  taskType?: string | null;
  contactId?: string | null;
  firstName?: string | null;
  companyName?: string | null;
  interest?: string | null;
  hasFile?: boolean;
  useLlm?: boolean;
}) {
  if (!wantsClientMessageDraft(input.taskType)) return null;

  let fact: ContactComposeFact | null = null;
  if (input.contactId) {
    fact = (await loadContactComposeFacts(input.prisma, input.tenantId, [input.contactId]))[0] || null;
  }

  const firstName = fact?.firstName || pickPersonFirstName(input.firstName);
  const companyName = fact?.companyName || input.companyName || null;
  const interest = fact?.interest || pickUsableInterest(input.interest);
  const deterministic = composeDeterministicClientDraft({
    taskText: input.taskText,
    firstName,
    companyName,
    interest,
    hasFile: input.hasFile,
  });

  if (input.useLlm === false) return deterministic;

  const llmText = await composeClientMessageWithLlm({
    instruction: input.taskText,
    firstName,
    companyName,
    interest,
    lastClientMessage: fact?.lastClientMessage,
    history: fact?.history,
  });
  if (llmText && acceptPersonalizedDraft({ taskText: input.taskText, firstName, draft: llmText })) {
    return llmText;
  }
  return deterministic;
}

export async function composeCommandDraftsForContacts(input: {
  prisma: PrismaClient;
  tenantId: string;
  taskText: string;
  contactIds: string[];
  userDraft?: string | null;
  hasFile?: boolean;
  useLlm?: boolean;
}) {
  const facts = await loadContactComposeFacts(input.prisma, input.tenantId, input.contactIds);
  const userDraft = String(input.userDraft || "").trim();
  const taskText = String(input.taskText || "").trim();

  if (facts.length === 1 && keepUserDraft(userDraft)) {
    return [{ contactId: facts[0].contactId, text: userDraft }];
  }

  const firstName = facts[0]?.firstName;
  const personalizedToFirst =
    Boolean(firstName) && new RegExp(`^${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`, "i").test(userDraft);
  const sharedDraft =
    userDraft &&
    !looksLikeStaffCommand(userDraft) &&
    !isGenericTemplateDraft(userDraft) &&
    (facts.length <= 1 || !personalizedToFirst)
      ? userDraft
      : "";

  const rows = facts.length
    ? facts
    : input.contactIds.map((contactId) => ({
        contactId,
        firstName: null,
        companyName: null,
        interest: null,
        lastClientMessage: null,
        history: [] as ContactComposeFact["history"],
      }));
  let drafts = rows.map((fact) => ({
    contactId: fact.contactId,
    text: composeDeterministicClientDraft({
      taskText,
      sharedDraft,
      firstName: fact.firstName,
      companyName: fact.companyName,
      interest: fact.interest,
      hasFile: input.hasFile,
    }),
  }));

  if (input.useLlm === false || !drafts.length) return drafts;

  if (drafts.length === 1) {
    const fact = facts[0];
    const llmText = await composeClientMessageWithLlm({
      instruction: taskText,
      firstName: fact?.firstName,
      companyName: fact?.companyName,
      interest: fact?.interest,
      lastClientMessage: fact?.lastClientMessage,
      history: fact?.history,
    });
    if (llmText && acceptPersonalizedDraft({ taskText, firstName: fact?.firstName, draft: llmText })) {
      drafts = [{ contactId: drafts[0].contactId, text: llmText }];
    }
    return drafts;
  }

  const refined = await refineCampaignRecipientDraftsWithLlm({
    taskText,
    clientAsk: clientFacingAskFromTask(taskText) || clientAskFromStaffTask(taskText),
    kind: inferCampaignOfferKind(taskText, sharedDraft),
    hasFile: Boolean(input.hasFile),
    recipients: drafts.map((row) => {
      const fact = facts.find((item) => item.contactId === row.contactId);
      return {
        id: row.contactId,
        firstName: fact?.firstName || null,
        companyName: fact?.companyName || null,
        interest: fact?.interest || null,
        draft: row.text,
      };
    }),
  });
  if (refined?.length) {
    const byId = new Map(refined.map((row) => [row.id, row.text]));
    drafts = drafts.map((row) => {
      const next = byId.get(row.contactId);
      const fact = facts.find((item) => item.contactId === row.contactId);
      if (!next || !acceptPersonalizedDraft({ taskText, firstName: fact?.firstName, draft: next })) return row;
      return { contactId: row.contactId, text: next };
    });
  }
  return drafts;
}
