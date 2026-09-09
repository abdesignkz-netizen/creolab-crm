import { extractSpokenMessage } from "./spokenMessage.ts";
import { isGenericLeadLabel } from "./contactInterestService.ts";

export type CampaignOfferKind = "proposal" | "documents" | "follow_up" | "message";

export type RecipientOfferInput = {
  taskText?: string | null;
  sharedDraft?: string | null;
  firstName?: string | null;
  companyName?: string | null;
  interest?: string | null;
  hasFile?: boolean;
};

export function personalize(
  template: string,
  vars: { firstName?: string | null; companyName?: string | null; service?: string | null; managerName?: string | null },
) {
  let text = template;
  const firstName = String(vars.firstName || "").trim();
  if (/\{\{\s*firstName\s*\}\}/i.test(text)) {
    text = text.replace(/\{\{\s*firstName\s*\}\}\s*,?\s*/gi, firstName ? `${firstName}, ` : "");
  }
  text = text
    .replace(/\{\{\s*companyName\s*\}\}/gi, vars.companyName || "")
    .replace(/\{\{\s*service\s*\}\}/gi, vars.service || "")
    .replace(/\{\{\s*managerName\s*\}\}/gi, vars.managerName || "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (/^,?\s*добрый день/i.test(text)) text = text.replace(/^,?\s*/, "");
  if (!text) text = "Добрый день!";
  return text;
}

const STAFF_VERB_RE =
  /^(пожалуйста[,\s]+)?(уточни(?:те|ть)?|отправ(?:ь|ьте|ить)|напиш(?:и|ите|ать)|напомни(?:те|ть)?|спроси(?:те)?|собери(?:те)?|разошли(?:те)?|позвони(?:те)?|перезвон\w*|скажи(?:те)?|подготовь(?:те)?|сделай(?:те)?|проверь(?:те)?|свяжись|свяжитесь)\s+/i;
const NOT_A_PERSON_NAME =
  /^(без|клиент|контакт|unknown|интерес|имя|компания|телефон|email|e-mail|почта|заявка|лид|lead|service|subject|whatsapp|telegram)$/i;
const TASK_STOP_WORDS = new Set([
  "хотели",
  "уточнить",
  "уточни",
  "напомнить",
  "напомни",
  "спросить",
  "отправить",
  "написать",
  "напиши",
  "пожалуйста",
  "клиенту",
  "клиентам",
  "заявки",
  "заявке",
  "заявка",
  "всем",
  "этим",
  "вашу",
  "вашей",
]);

function isRelevanceOnlyAsk(text: string) {
  const t = String(text || "").toLowerCase();
  if (/созвон|звонк|удобн|оплат|встреч|слот|когда/.test(t)) return false;
  return /актуальн/.test(t);
}

export function inferCampaignOfferKind(taskText: string, sharedDraft = ""): CampaignOfferKind {
  const text = `${taskText} ${sharedDraft}`.toLowerCase();
  if (/\b(кп|коммерческ\w*\s+предложен\w*|proposal|оффер)\b/.test(text) || /отправ.{0,40}(кп|предложен)/.test(text)) {
    return "proposal";
  }
  if (/отправ.{0,30}(файл|документ|договор|презентац|смет|вложен)/.test(text)) return "documents";
  if (isRelevanceOnlyAsk(text) || (/напомн|follow/.test(text) && !/созвон|звонк|удобн|оплат|встреч/.test(text))) {
    return "follow_up";
  }
  return "message";
}

export function firstNameOf(name?: string | null) {
  const raw = String(name || "").trim();
  if (!raw || /без имени|не указан|unknown/i.test(raw) || NOT_A_PERSON_NAME.test(raw)) return null;
  const part = raw.split(/\s+/)[0] || "";
  if (!part || NOT_A_PERSON_NAME.test(part)) return null;
  return part;
}

export function campaignTaskDedupeKey(campaignId: string) {
  return `campaign:${campaignId}`;
}

export function isCampaignBackedTask(task?: { parsedCommandJson?: unknown; dedupeKey?: string | null } | null) {
  if (!task) return false;
  if (String(task.dedupeKey || "").startsWith("campaign:")) return true;
  const parsed =
    task.parsedCommandJson && typeof task.parsedCommandJson === "object"
      ? (task.parsedCommandJson as { sendViaCampaign?: boolean; campaignId?: string })
      : null;
  return Boolean(parsed?.sendViaCampaign || parsed?.campaignId);
}

export function pickPersonFirstName(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const name = firstNameOf(value);
    if (name) return name;
  }
  return null;
}

/** Imperative to the CRM/manager, not a WhatsApp text for the client. */
export function looksLikeStaffCommand(text: string) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/\{\{\s*\w+\s*\}\}/.test(t)) return false;
  if (/добрый день|здравствуйте|во вложении|направляем|хотели уточнить/i.test(t)) return false;
  if (t.length > 220) return false;
  return /^(уточни(?:ть)?|отправ(?:ь|ьте|ить)|напиши|напомни(?:ть)?|собери|разошли|позвони|перезвон\w*|скажи|подготовь|сделай|проверь|свяжись)(?:\s|$|[.,!?])/i.test(
    t,
  );
}

function cleanFact(value?: string | null, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function clientFacingInterest(value?: string | null) {
  const text = cleanFact(value);
  if (!text || isGenericLeadLabel(text)) return null;
  return text;
}

function aboutRequest(interest?: string | null, companyName?: string | null) {
  const interestClean = clientFacingInterest(interest);
  if (interestClean) return `по вашему запросу «${interestClean}»`;
  const companyClean = cleanFact(companyName, 80);
  if (companyClean) return `по заявке ${companyClean}`;
  return "";
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tidy(text: string) {
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function primaryTaskLine(taskText: string, sharedDraft = "") {
  const lines = `${taskText}\n${sharedDraft}`
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.find((line) => looksLikeStaffCommand(line)) || lines[0] || "";
}

function infinitiveFromStaffVerb(verb: string) {
  const v = verb.toLowerCase();
  if (/^уточн/.test(v)) return "уточнить";
  if (/^напомн/.test(v)) return "напомнить";
  if (/^спроси/.test(v)) return "спросить";
  if (/^отправ/.test(v)) return "отправить";
  if (/^напиш/.test(v)) return "написать";
  if (/^скаж/.test(v)) return "сказать";
  return "уточнить";
}

/** Turn «Уточнить удобное время для созвона» into a client-facing ask. Not a canned relevance template. */
export function clientAskFromStaffTask(taskText: string): string | null {
  const raw = String(taskText || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (!looksLikeStaffCommand(raw) && !STAFF_VERB_RE.test(raw)) return null;
  const rest = raw.replace(STAFF_VERB_RE, "").replace(/[.!?]+$/u, "").trim();
  if (!rest || rest.length < 3) return null;
  if (isRelevanceOnlyAsk(rest) || isRelevanceOnlyAsk(raw)) return null;
  const verb = raw.match(STAFF_VERB_RE)?.[2] || "уточнить";
  const infinitive = infinitiveFromStaffVerb(verb);
  if (rest.toLowerCase().startsWith(infinitive)) return `Хотели ${rest}.`;
  if (/^(когда|куда|как|что|почему)/i.test(rest)) {
    return `Хотели ${infinitive}, ${rest.charAt(0).toLowerCase()}${rest.slice(1)}.`;
  }
  return `Хотели ${infinitive} ${rest}.`;
}

export function acceptPersonalizedDraft(input: { taskText: string; firstName?: string | null; draft: string }) {
  const draft = String(input.draft || "").trim();
  if (!draft) return false;
  const greeting = draft.match(/^([^,\n]{1,48}),\s*(добрый день|здравствуйте)\b/i);
  if (greeting) {
    const used = greeting[1].trim();
    const allowed = firstNameOf(input.firstName);
    if (firstNameOf(used) === null) return false;
    if (allowed && used.toLowerCase() !== allowed.toLowerCase()) return false;
  }
  const ask = clientAskFromStaffTask(primaryTaskLine(input.taskText));
  if (!ask) return true;
  const tokens = ask
    .toLowerCase()
    .split(/[^а-яёa-z0-9]+/i)
    .filter((word) => word.length >= 4 && !TASK_STOP_WORDS.has(word));
  if (!tokens.length) return true;
  const hay = draft.toLowerCase();
  return tokens.some((token) => {
    if (hay.includes(token)) return true;
    const stem = token.slice(0, Math.min(5, token.length));
    return stem.length >= 4 && hay.includes(stem);
  });
}

export function composeRecipientOffer(input: RecipientOfferInput) {
  const taskText = String(input.taskText || "").trim();
  const sharedRaw = String(input.sharedDraft || "").trim();
  const commandLikeDraft = looksLikeStaffCommand(sharedRaw);
  const sharedDraft = commandLikeDraft ? "" : sharedRaw;
  const effectiveTask = [taskText, commandLikeDraft ? sharedRaw : ""].filter(Boolean).join("\n");
  const firstName = firstNameOf(input.firstName);
  const companyName = cleanFact(input.companyName, 80) || null;
  const interest = clientFacingInterest(input.interest);
  const hasFile = Boolean(input.hasFile);
  const kind = inferCampaignOfferKind(effectiveTask, sharedDraft);
  const spokenRaw = extractSpokenMessage(effectiveTask);
  const spoken = spokenRaw && !looksLikeStaffCommand(spokenRaw) ? spokenRaw : null;
  const greeting = firstName ? `${firstName}, добрый день!` : "Добрый день!";
  const about = aboutRequest(interest, companyName);
  const fileBit = hasFile ? " Во вложении — материалы." : "";
  const staffAsk = clientAskFromStaffTask(primaryTaskLine(effectiveTask, sharedRaw));

  if (spoken) {
    const body = spoken.replace(/^[^.!?]+,\s*добрый день[!?.]?\s*/i, "").trim();
    const extra = about ? ` ${capitalize(about)}.` : "";
    return tidy(`${greeting} ${body}${extra}${fileBit}`);
  }

  if (sharedDraft) {
    let text = personalize(sharedDraft, {
      firstName,
      companyName,
      service: interest,
    });
    const alreadyMentions =
      (interest && text.toLowerCase().includes(interest.toLowerCase())) ||
      (companyName && text.toLowerCase().includes(companyName.toLowerCase()));
    if (about && !alreadyMentions) {
      if (/(добрый день[!?.]?)/i.test(text)) {
        text = text.replace(/(добрый день[!?.]?)\s*/i, `$1 ${capitalize(about)} `);
        text = text.replace(
          new RegExp(`(${escapeRegExp(capitalize(about))})\\s+([А-ЯA-Z])`, "u"),
          (_, clause, letter) => `${clause} ${letter.toLowerCase()}`,
        );
      } else {
        text = `${text} ${capitalize(about)}.`;
      }
    }
    return tidy(text);
  }

  if (staffAsk && kind !== "proposal" && kind !== "documents") {
    const extra = about ? ` ${capitalize(about)}.` : "";
    return tidy(`${greeting} ${staffAsk}${extra}${fileBit}`);
  }

  switch (kind) {
    case "proposal":
      return tidy(
        `${greeting} ${about ? `${capitalize(about)} ` : ""}направляем коммерческое предложение.${fileBit} Если актуально, напишите — уточним детали.`,
      );
    case "documents":
      return tidy(
        `${greeting} ${about ? `${capitalize(about)} ` : ""}направляем документы.${fileBit} Если нужно что-то ещё — напишите.`,
      );
    case "follow_up":
      return tidy(
        interest
          ? `${greeting} Хотели уточнить, актуален ли ещё запрос «${interest}».${fileBit} Можем продолжить.`
          : `${greeting} Хотели уточнить, актуальна ли ещё ваша заявка.${fileBit} Можем продолжить.`,
      );
    default:
      return tidy(
        `${greeting}${about ? ` Пишем ${about}.` : " Пишем по вашей заявке."}${fileBit} Если вопрос ещё открыт, напишите — подскажем следующий шаг.`,
      );
  }
}

export function recipientDraftsFingerprint(
  recipients: Array<{ id: string; status: string; messageDraft?: string | null }>,
) {
  return recipients
    .filter((row) => ["pending", "queued", "sending"].includes(row.status))
    .map((row) => `${row.id}:${String(row.messageDraft || "").trim()}`)
    .sort()
    .join("\n");
}

export function resolveRecipientSendText(input: {
  personalizeEach?: boolean | null;
  recipientDraft?: string | null;
  campaignSnapshot?: string | null;
  campaignDraft?: string | null;
  firstName?: string | null;
  companyName?: string | null;
  interest?: string | null;
}) {
  const own = String(input.recipientDraft || "").trim();
  if (input.personalizeEach && own) {
    return personalize(own, {
      firstName: input.firstName,
      companyName: input.companyName,
      service: input.interest,
    });
  }
  const template = String(input.campaignSnapshot || input.campaignDraft || "").trim();
  if (!template) return "";
  return personalize(template, {
    firstName: input.firstName,
    companyName: input.companyName,
    service: input.interest,
  });
}
