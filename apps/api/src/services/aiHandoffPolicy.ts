import type { AIAutomationSettings, HandoffTriggerKey } from "./aiAutomationSettings.ts";

// Only explicit requests. Mentions of a person, a job title or a price per person
// are not consent to stop automation. Evaluate negation within the same clause.
export function isHumanRequested(text: string) {
  return text.split(/[.!?;\n]+|,\s*(?:но|бірақ|but)\s+/iu).some(clause => {
    if (/без\s+(?:менеджер|оператор|человек)|не\s+(?:нужен|нужна|надо|нужно|хочу|зовите|передавайте|переводите|соединяйте)|(?:менеджер|оператор|қызметкер|адам)[^.!?]{0,35}(?:бермеңіз|қоспаңыз|ауыстырмаңыз|керек емес|қаламаймын|келмейді)|don['’]?t|do not|without/iu.test(clause)) return false;
    return /(?:позовите|пригласите|подключите|соедините|свяжите|переведите|передайте)[^.!?]{0,45}(?:менеджер|оператор|человек|сотрудник)|(?:нужен|нужна)\s+(?:менеджер|оператор|человек|сотрудник)|(?:хочу|можно)\s+(?:(?:поговорить|общаться|связаться|связь|говорить)\s+)?(?:с\s+)?(?:менеджер|оператор|человек|сотрудник)|(?:менеджер|оператор|сотрудник)[^.!?]{0,20}(?:пожалуйста|позовите|подключите)|(?:менеджермен|оператормен|қызметкермен|адаммен)[^.!?]{0,35}(?:сөйлес|байланыс)|(?:менеджерге|операторға|қызметкерге|адамға)[^.!?]{0,25}(?:беріңіз|қосыңыз|ауыстырыңыз)|(?:talk|speak|connect|transfer)[^.!?]{0,25}(?:human|person|agent)|human please/iu.test(clause.trim())
      || /^(?:менеджер|оператор|живой человек|қызметкер|адам керек)[!?.\s]*$/iu.test(clause.trim());
  });
}

export function isClientRefusalText(text: string) {
  text = text.replace(/\[Расшифровка голосового сообщения\]:\s*/gu, "").trim();
  // Refusing a quantity, option or a handoff is not a refusal of the conversation.
  return /(?<![\p{L}\p{N}])(?:больше не пишите|не пишите (?:мне|нам|больше)|больше не связывайтесь|отпишите меня|маған (?:енді )?(?:жазбаңыз|хабарласпаңыз)|stop contacting me|stop messaging me|unsubscribe)(?![\p{L}\p{N}])/iu.test(text)
    || /^(?:спасибо[,!\s]+)?(?:не интересно|неинтересно|не надо|не нужно|отказываюсь|сам напишу|стоп|stop|не пишите|перестаньте писать|қызықтырмайды|керек емес|жазбаңыз|хабарласпаңыз)[.!\s]*$/iu.test(text.trim());
}

// Match Russian legal words, not fragments inside «обсудить» or «посуда».
// JS \b is ASCII-based, so Cyrillic needs Unicode letter boundaries.
const CONFLICT_RE = /(?<![\p{L}\p{N}_])(?:конфликт\p{L}*|суд(?:а|у|ом|е|ы|ов|ам|ами|ах)?|судебн\p{L}*|судиться|адвокат\p{L}*|прокуратур\p{L}*)(?![\p{L}\p{N}_])/iu;
const REASON_PATTERNS: Array<{ code: string; trigger: HandoffTriggerKey; re: RegExp }> = [
  { code: "COMPLAINT", trigger: "COMPLAINT", re: /жалоб|возмущ|хамств|обман|претензи/i },
  { code: "CONFLICT", trigger: "COMPLAINT", re: CONFLICT_RE },
  { code: "CONTRACT", trigger: "CONTRACT", re: /договор|контракт|оферт/i },
  { code: "PAYMENT", trigger: "PAYMENT", re: /оплат|сч[её]т\b|платеж|каспи|iban/i },
  { code: "CUSTOM_PRICING", trigger: "CUSTOM_PRICING", re: /индивидуальн.{0,12}цен|скидк|нестандартн.{0,16}услов|спеццен/i },
  { code: "TECHNICAL_QUESTION", trigger: "OTHER", re: /интеграц|api|webhook|кастом|нестандартн.{0,12}запрос/i },
];

export function detectHandoffReason(
  text: string,
  analysis?: { humanRequired?: boolean; humanReason?: string | null; confidence?: string | null } | null,
): { code: string; trigger: HandoffTriggerKey } | null {
  const hay = String(text || "");
  if (isHumanRequested(hay)) return { code: "CLIENT_REQUESTED_HUMAN", trigger: "CLIENT_REQUESTED_HUMAN" };
  for (const row of REASON_PATTERNS) {
    if (row.re.test(hay)) return { code: row.code, trigger: row.trigger };
  }
  const reason = String(analysis?.humanReason || "").trim();
  if (reason === "CLIENT_REQUESTED_HUMAN" || reason === "COMPLAINT" || reason === "CONFLICT" || reason === "CONTRACT" || reason === "PAYMENT" || reason === "CUSTOM_PRICING" || reason === "LOW_CONFIDENCE" || reason === "OTHER" || reason === "TECHNICAL_QUESTION" || reason === "AI_ERROR") {
    const trigger: HandoffTriggerKey =
      reason === "CONFLICT"
        ? "COMPLAINT"
        : reason === "TECHNICAL_QUESTION" || reason === "AI_ERROR"
          ? "OTHER"
          : (reason as HandoffTriggerKey);
    return { code: reason, trigger };
  }
  if (analysis?.confidence === "LOW" || (analysis?.humanRequired && analysis.confidence === "LOW")) {
    return { code: "LOW_CONFIDENCE", trigger: "LOW_CONFIDENCE" };
  }
  if (analysis?.humanRequired) return { code: analysis.humanReason || "OTHER", trigger: "OTHER" };
  return null;
}


/** Shared by production replies and the owner's sandbox. */
export function directHandoffReason(text: string, settings: AIAutomationSettings): string | null {
  if (isClientRefusalText(text)) return "CLIENT_REFUSED";
  const detected = detectHandoffReason(text);
  return detected && (detected.code === "CLIENT_REQUESTED_HUMAN" || settings.handoff.triggers[detected.trigger]) ? detected.code : null;
}

export function handoffAcknowledgement(reason: string | null | undefined, history: Array<{ role: string; content: string }>) {
  if (reason === "CLIENT_REFUSED") return "";
  const clientText = [...history].reverse().filter(message => message.role === "user").map(message => message.content);
  const languageText = clientText.find(text => /[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]/u.test(text)) || "";
  const kk = /[ӘәҒғҚқҢңӨөҰұҮүҺһІі]|сәлем|керек|болады|рахмет|қанша/iu.test(languageText);
  const missing = ["knowledge_missing", "AI_KNOWLEDGE_MISSING"].includes(reason || "");
  return kk
    ? missing ? "Бұл сұраққа нақты жауап беру үшін ақпаратты қызметкерден нақтылау қажет. Сұрағыңызды қызметкерге жібердім." : "Сұрағыңызды қызметкерге жібердім. Ол осы диалогта жауап бере алады."
    : missing ? "Чтобы ответить точно, нужно уточнить информацию у сотрудника. Передал ему ваш вопрос." : "Передал ваш вопрос сотруднику. Он сможет ответить в этом диалоге.";
}
