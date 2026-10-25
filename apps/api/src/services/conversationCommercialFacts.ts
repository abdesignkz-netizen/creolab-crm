import { crmCommercialFactSchema, type CrmCommercialFact, type CrmMoney } from "@creolab/contracts";
import type { SituationMessage } from "./conversationContextService.ts";

const budget = /бюджет|budget|бюджетіміз/iu;
const offer = /стоимост|цена|предложени|за весь|итого|price|offer|total|баға|бағасы|құны/iu;
const acceptance = /устраива(?:ет|ют)|соглас(?:ен|на|ны)|фиксируем|бер[её]м|подходит|accept|agreed|келісем|келістік/iu;
const uncertain = /\?|если|при услов|возможн|предполож|\bif\b|provided|егер|шамамен|примерно|около|about|согласил.{0,5} бы|устраивало бы/iu;
const notTotal = /предоплат|аванс|депозит|за месяц|в месяц|ежемесяч|рассроч|за час|за штуку|за единицу|per (?:month|hour|unit)|deposit|installment|алдын ала|ай сайын|сағатына|%/iu;
const negative = /не соглас|не устраива|не подходит|не фиксир|не бер|дорог|отказ|подума|not accept|disagree|don't|келіспей|қымбат/iu;
const refusal = /отказыва(?:юсь|емся)|не будем (?:заказ|покуп|продолж|работ)|выбрали (?:друг|конкурент)|выбрал (?:друг|конкурент)|отменя(?:ю|ем) заказ|заказывать не будем|cancel (?:my |the )?order|chosen another|бас тарт(?:ам|тық|тым)/iu;
const objection = /дорог|не устраива|не подходит|нет бюджета|не успе|слишком долго|дешевле|сомнева|expensive|too slow|no budget|қымбат|бюджет жоқ|күмән/iu;
const partialRefusal = /от (?:этой |такой |предложенной )?(?:цен|скид|предоплат|вариант|услови)/iu;
const reportedOrCommand = /сказал|говорит|цитат|он согласен|они согласны|said|says|[«»“”"]|запиши|установи|измени|обнови|игнорируй|ignore|system prompt/iu;
const obsolete = /раньше|ранее|в прошлом|прежн|старая|неактуальн|used to|previous(?:ly)?|бұрын/iu;
const client = (m: SituationMessage) => m.direction === "inbound" && m.senderKind === "client";
const seller = (m: SituationMessage) => m.direction === "outbound" && ["staff", "ai"].includes(m.senderKind);

/** Conservative literal check, not a second language model. Ambiguous money stays
 * in the conversation for manual entry; there is no currency conversion/rounding. */
function moneyIn(text: string, currency: string, isBudget: boolean): CrmMoney | null {
  if (uncertain.test(text) || notTotal.test(text) || obsolete.test(text) || /\d\s*[:/]\s*\d|(?:^|[\s:])[-−]\s*\d|не\s+\d/iu.test(text)) return null;
  if ([...text.matchAll(/\b[A-Z]{3}\b/g)].some(m => !["KZT", "USD", "EUR", "RUB"].includes(m[0])) || /юан|сом|сум|фунт/iu.test(text)) return null;
  const amounts = [...text.matchAll(/(?<![\p{L}\d.,])([$€₸]|KZT|USD|EUR|RUB)?\s*(\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(тыс(?:яч[аиу]?)?\.?|[кk](?![\p{L}])|млн\.?|мың|миллион)?\s*(₸|тенге|тг(?![\p{L}])|kzt|usd|eur|rub|руб(?:лей)?|\$|€)?/giu)]
    .filter(m => m[1] || m[4] || m[5] || Number(m[2].replace(/\s/g, "")) >= 1000)
    .map(m => ({ amount: Number(m[2].replace(/\s/g, "") + (m[3] ? "." + m[3] : "")) * (m[4] ? /млн|миллион/iu.test(m[4]) ? 1e6 : 1000 : 1),
      currency: /usd|\$/iu.test((m[1] || "") + (m[5] || "")) ? "USD" : /eur|€/iu.test((m[1] || "") + (m[5] || "")) ? "EUR"
        : /rub|руб/iu.test((m[1] || "") + (m[5] || "")) ? "RUB" : m[1] || m[5] ? "KZT" : currency }));
  if (!amounts.length || amounts.length > (isBudget ? 2 : 1) || amounts.some(a => !Number.isInteger(a.amount) || a.amount < 0 || a.amount > 2_147_483_647)) return null;
  if (amounts.length === 2) {
    if (amounts[0].currency !== amounts[1].currency || amounts[0].amount > amounts[1].amount || !/(?:от|from)\s*\d.+(?:до|to)\s*\d|\d\s*(?:тыс\.?|[кk]|мың)?\s*[-–—]\s*\d/iu.test(text)) return null;
    return { min: amounts[0].amount, max: amounts[1].amount, currency: amounts[0].currency };
  }
  const a = amounts[0];
  const upper = isBudget && /(?:до|не более|максимум|up to|maximum)\s*\d/iu.test(text);
  const lower = isBudget && /(?:от|не менее|минимум|at least|minimum)\s*\d/iu.test(text);
  if (!isBudget && /(?:от|до|from|up to|starting)\s*\d/iu.test(text)) return null;
  return { min: upper ? null : a.amount, max: lower ? null : a.amount, currency: a.currency };
}

/** Run both after LLM extraction and again inside the application transaction. */
export function groundCommercialFacts(raw: unknown, messages: SituationMessage[], currency: string): CrmCommercialFact[] {
  if (!Array.isArray(raw)) return [];
  const visible = messages.filter(m => !m.internal && m.id && m.text);
  const last = visible.at(-1);
  if (!last?.id || !last.text || reportedOrCommand.test(last.text)) return [];
  const duplicates = new Set<string>();
  const results: CrmCommercialFact[] = [];
  for (const item of raw.slice(0, 20)) {
    const parsed = crmCommercialFactSchema.safeParse(item);
    if (!parsed.success || parsed.data.confidence === "LOW") continue;
    const fact = parsed.data;
    const evidence = fact.evidence.map(e => ({ ...e, message: visible.find(m => m.id === e.messageId) }));
    if (!evidence.some(e => e.messageId === last.id) || new Set(evidence.map(e => e.messageId)).size !== evidence.length ||
        evidence.some(e => !e.message?.text?.includes(e.quote))) continue;
    const latestQuote = evidence.find(e => e.messageId === last.id)!.quote;
    // Check the full message as well as the quote: do not drop "не" or a condition
    // by citing only the convenient substring returned by the model.
    let expected: CrmMoney | string | null = null;
    if (fact.field === "customerBudget" && client(last) && budget.test(last.text) && budget.test(latestQuote)) {
      expected = moneyIn(last.text, currency, true);
      if (JSON.stringify(expected) !== JSON.stringify(moneyIn(latestQuote, currency, true))) continue;
    } else if (fact.field === "proposedPrice" && seller(last) && offer.test(last.text) && offer.test(latestQuote) && !budget.test(last.text) && !negative.test(last.text)) {
      expected = moneyIn(last.text, currency, false);
      if (JSON.stringify(expected) !== JSON.stringify(moneyIn(latestQuote, currency, false))) continue;
    } else if (fact.field === "agreedPrice" && client(last) && acceptance.test(last.text) && acceptance.test(latestQuote) && !negative.test(last.text) && !budget.test(last.text) && !uncertain.test(last.text) && !notTotal.test(last.text)) {
      expected = moneyIn(last.text, currency, false);
      if (expected) {
        if (JSON.stringify(expected) !== JSON.stringify(moneyIn(latestQuote, currency, false))) continue;
      } else if (/^(?:да[,! ]*)?(?:согласен|согласна|согласны|agreed|келісемін)[.! ]*$/iu.test(last.text.trim())) {
        const previous = visible.at(-2), quote = evidence.find(e => e.messageId === previous?.id)?.quote;
        if (previous?.text && seller(previous) && quote && offer.test(previous.text) && !budget.test(previous.text) && !negative.test(previous.text) && !reportedOrCommand.test(previous.text)) {
          expected = moneyIn(previous.text, currency, false);
          if (JSON.stringify(expected) !== JSON.stringify(moneyIn(quote, currency, false))) continue;
        }
      }
    } else if (fact.field === "objection" && client(last) && objection.test(latestQuote) && !refusal.test(last.text) && !/не дорог|not expensive|қымбат емес/iu.test(last.text)) {
      expected = latestQuote;
    } else if (fact.field === "refusalReason" && client(last) && refusal.test(latestQuote) && !partialRefusal.test(last.text) && !/не отказыва|не отменя|not cancel|не выбрал/iu.test(last.text) && !uncertain.test(last.text)) {
      expected = latestQuote;
    }
    if (expected === null || JSON.stringify(expected) !== JSON.stringify(fact.value)) continue;
    if (results.some(f => f.field === fact.field)) duplicates.add(fact.field);
    results.push(fact);
  }
  return results.filter(f => !duplicates.has(f.field));
}

/** Offline fallback handles only explicit statements. Model suggestions use the
 * same evidence checks and remain subject to staff review. */
export function extractCommercialFacts(messages: SituationMessage[], currency: string): CrmCommercialFact[] {
  const visible = messages.filter(m => !m.internal && m.id && m.text);
  const last = visible.at(-1);
  if (!last?.text || !last.id || last.text.length > 2000) return [];
  const evidence = [{ messageId: last.id, quote: last.text }];
  const candidates: unknown[] = [];
  const add = (field: string, value: unknown, source = evidence) => value !== null && candidates.push({ field, value, evidence: source, confidence: "HIGH" });
  if (client(last)) {
    if (budget.test(last.text)) add("customerBudget", moneyIn(last.text, currency, true));
    if (acceptance.test(last.text)) {
      let money = moneyIn(last.text, currency, false), source = evidence;
      const previous = visible.at(-2);
      if (!money && previous?.text && previous.id && previous.text.length <= 2000 && seller(previous)) {
        money = moneyIn(previous.text, currency, false);
        source = [{ messageId: previous.id, quote: previous.text }, ...evidence];
      }
      add("agreedPrice", money, source);
    }
    if (refusal.test(last.text)) add("refusalReason", last.text);
    else if (objection.test(last.text)) add("objection", last.text);
  } else if (seller(last) && offer.test(last.text)) add("proposedPrice", moneyIn(last.text, currency, false));
  return groundCommercialFacts(candidates, visible, currency);
}
