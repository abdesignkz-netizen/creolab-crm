import type { PrismaClient } from "@creolab/db";

type InterestMessage = {
  id: string;
  text?: string | null;
  direction: string;
  senderKind: string;
  internal?: boolean;
  createdAt: Date;
};

export type ContactInterest = { text: string; source: "inquiry" | "conversation"; messageId: string | null };

const SERVICES = [
  /сайт|лендинг|интернет[- ]магазин|website|landing/i,
  /презентац|presentation|питч[- ]?дек|pitch deck/i,
  /брендинг|брендбук|фирменн.{0,8}стил|branding/i,
  /логотип|logo/i,
  /дизайн|design/i,
  /реклам|таргет|маркетинг|\bsmm\b|\bseo\b|marketing/i,
  /\bcrm\b|срм|автоматизац|чат[- ]?бот/i,
  /видеоролик|монтаж|анимац|video/i,
  /приложени|application|mobile app/i,
];
const REQUEST = /нуж[еннаоы]|хот(?:им|ел|ела|елось|ят|ите)|хочу|интересу|заказ|сдела|созда|разработ|подготов|оформ|передела|обнов|помо(?:чь|гите)|стоимост|сколько|цен[ауы]|расцен|делаете|занимаетесь|можете|можно|требуется|керек|қажет|қанша|бағасы|\bneed\b|\bwant\b|\bcost\b|\bprice\b/i;
const NEGATIVE = /не\s+(?:нуж|интерес|хот|требу|будем|планир)|не\s+сейчас|отмен|отказ|больше не|пока не|не актуаль|not interested|don't need|керек емес/i;

/** Read explicit client requests only; staff pitches and internal notes are not evidence. */
export function inferClientInterest(messages: InterestMessage[]): ContactInterest | null {
  const excluded = new Set<number>();
  const recent = [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const message of recent) {
    if (message.internal || message.direction !== "inbound" || message.senderKind !== "client") continue;
    const text = (message.text || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    const clauses = text.split(/(?<=[.!?])\s+|[,;]?\s+(?:но|зато|а теперь)\s+|[,;]\s*(?=нуж|хочу|интересу|не нуж)/i).reverse();
    for (const clause of clauses) {
      const services = SERVICES.flatMap((pattern, index) => pattern.test(clause) ? [index] : []);
      if (NEGATIVE.test(clause)) {
        if (!services.length && /ничего|всё|все|проект|заказ/i.test(clause)) return null;
        services.forEach((index) => excluded.add(index));
        continue;
      }
      if (!services.some((index) => !excluded.has(index))) continue;
      // A short service name can be a direct answer to “Что вам нужно?”.
      const bareService = /^(?:сайт|лендинг|презентаци[яю]|брендинг|логотип|дизайн|реклама|crm|срм|чат[- ]?бот)[.!]?$/i.test(clause.trim());
      if (!REQUEST.test(clause) && !bareService) continue;
      const clean = clause.replace(/^(?:здравствуйте|добрый день|привет)[,! .]+/i, "").trim();
      return { text: clean.length > 220 ? `${clean.slice(0, 217)}…` : clean, source: "conversation", messageId: message.id };
    }
  }
  return null;
}

export function inquiryInterest(inquiry?: { subject?: string | null; service?: string | null } | null): ContactInterest | null {
  const text = inquiry?.subject?.trim() || inquiry?.service?.trim();
  return text ? { text, source: "inquiry", messageId: null } : null;
}

/** One tenant-scoped batch, including closed/imported dialogs; never calls AI or writes on GET. */
export async function loadConversationInterests(prisma: PrismaClient, tenantId: string, contactIds: string[]) {
  const result = new Map<string, ContactInterest>();
  if (!contactIds.length) return result;
  const conversations = await prisma.conversation.findMany({
    where: { tenantId, contactId: { in: contactIds } },
    select: {
      contactId: true,
      messages: {
        where: { tenantId, direction: "inbound", senderKind: "client", internal: false, text: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, text: true, direction: true, senderKind: true, internal: true, createdAt: true },
      },
    },
  });
  const grouped = new Map<string, InterestMessage[]>();
  for (const conversation of conversations) {
    if (!conversation.contactId) continue;
    const messages = grouped.get(conversation.contactId) || [];
    messages.push(...conversation.messages);
    grouped.set(conversation.contactId, messages);
  }
  for (const [contactId, messages] of grouped) {
    const interest = inferClientInterest(messages);
    if (interest) result.set(contactId, interest);
  }
  return result;
}
