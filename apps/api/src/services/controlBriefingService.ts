import type { PrismaClient } from "@creolab/db";
import type { ControlAction, BusinessHomeFocus } from "@creolab/contracts";
import type { ControlChatExecutor } from "./controlChatService.ts";
import { ApiError } from "../errors.ts";
import { cleanText, words, type ChatLanguage } from "./controlChatLanguage.ts";
import { controlLink, presentControlReply } from "./controlChatPresentation.ts";
import { controlAuthorizationVersion } from "./aiControlService.ts";
import { getBusinessHomeFocus } from "./businessHomeService.ts";
import { addDaysYmd, pad, zonedYmd } from "./periodRange.ts";

export function nextBriefingDay(now: Date, timeZone: string) {
  const d = addDaysYmd(zonedYmd(now, timeZone), 1);
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}
/** Truncate content only at line boundaries; never cut a source URL in half. */
export function fitBriefingBlock(text: string, limit = 720) {
  const lines = text.split("\n"), links = lines.filter(l => /^https?:\/\/\S+$/.test(l));
  const footer = links.at(-1) || "", body: string[] = [];
  for (const line of lines.filter(l => !links.includes(l))) {
    const next = cleanText(line, 200);
    if ([...body, next, "…", footer].join("\n").length > limit) { body.push("…"); break; }
    body.push(next);
  }
  return [...body, footer].filter(Boolean).join("\n");
}
export function homeBriefingBlocks(focus: BusinessHomeFocus, lang: ChatLanguage) {
  const w = (ru: string, kk: string) => words(lang, ru, kk), blocks: string[] = [];
  if (focus.insights.status === "unavailable") blocks.push(w("Выводы не удалось проверить. Это не означает, что проблем нет.", "Қорытындылар тексерілмеді. Бұл мәселелер жоқ дегенді білдірмейді."));
  for (const i of focus.insights.items) blocks.push(`${w("Важный сигнал", "Маңызды сигнал")}: ${cleanText(i.title, 110)}\n${cleanText(i.detail, 200)}\n${cleanText(i.limitation, 100)}\n${controlLink(i.href)}`);
  if (focus.insights.items.length) blocks.push(w("Показана выборка актуальных сигналов, не полный аудит компании.", "Компанияның толық аудиті емес, өзекті сигналдардың іріктемесі көрсетілген."));
  if (focus.actions.status === "unavailable") blocks.push(w("Статусы планов не удалось проверить.", "Жоспарлардың күйлері тексерілмеді."));
  else {
    for (const a of focus.actions.items.slice(0, 1)) blocks.push(`${a.status === "draft" ? w("Ждёт вашего подтверждения", "Сіздің растауыңызды күтуде") : w("План выполняется", "Жоспар орындалуда")}: ${cleanText(a.title, 120)}\n${controlLink(a.href)}`);
    for (const a of focus.actions.recent.slice(0, 1)) blocks.push(`${a.status === "succeeded" ? w("Шаги выполнены", "Қадамдар орындалды") : w("Нужна проверка результата", "Нәтижені тексеру керек")}: ${cleanText(a.title, 120)} (${a.completed}/${a.steps})\n${w("Результаты выполнения за 7 дней; это не подтверждение достижения бизнес-цели.", "7 күндегі орындалу нәтижелері; бұл бизнес-мақсатқа қол жеткізілгенін растамайды.")}\n${controlLink(a.href)}`);
  }
  const goal = focus.goals.items[0];
  if (goal) blocks.push(`${w("Цель", "Мақсат")}: ${cleanText(goal.title, 100)}\n${goal.progress === null ? w("Нужно проверить актуальное измерение.", "Өзекті өлшемді тексеру керек.") : `${goal.progress}%`}\n${controlLink(goal.href)}`);
  return blocks;
}

export async function prepareControlBriefing(db: PrismaClient, input: {
  kinds: string[]; executor: ControlChatExecutor; allowed: readonly ControlAction[]; language: ChatLanguage;
  execute: (action: ControlAction, params?: Record<string, unknown>) => Promise<unknown>; now?: Date;
}) {
  const { executor, allowed, language: lang, execute } = input, now = input.now || new Date();
  const ctx = await executor.authorize(), tz = ctx.tenant.timezone || "Asia/Almaty", w = (ru: string, kk: string) => words(lang, ru, kk);
  const accessVersion = (c: typeof ctx) => controlAuthorizationVersion({ ...c, identity: { userId: c.auth.user.id } });
  const initialVersion = accessVersion(ctx), blocks: string[] = [];
  const morning = input.kinds.includes("morning"), evening = input.kinds.includes("evening");
  const title = morning && evening ? w("Утренняя и вечерняя сводка", "Таңғы және кешкі қорытынды") : evening ? w("Вечерняя сводка", "Кешкі қорытынды") : w("Утренняя сводка", "Таңғы қорытынды");
  const read = async (action: ControlAction, params: Record<string, unknown> = {}, heading?: string) => {
    if (!allowed.includes(action)) return;
    await executor.authorize(action);
    try { blocks.push(fitBriefingBlock(`${heading ? `${heading}\n` : ""}${presentControlReply(action, await execute(action, params), lang, tz)}`, 520)); }
    catch (e) {
      if (e instanceof ApiError && [401, 403].includes(e.status)) throw e;
      blocks.push(w("Часть сводки не загрузилась. Проверьте раздел в BasQar.", "Қорытындының бір бөлігі жүктелмеді. BasQar бөлімін тексеріңіз."));
    }
  };
  await read("GET_SITUATION");
  if (morning) await read("GET_TODAY_TASKS");
  if (evening) {
    await read("GET_BUSINESS_SUMMARY", { period: "today" });
    const day = nextBriefingDay(now, tz);
    await read("GET_TASKS", { period: "custom", dateFrom: day, dateTo: day, taskStatus: "active" }, w(`План на завтра · ${day}`, `Ертеңгі жоспар · ${day}`));
  }
  // A summary title can itself contain money/team data. Never bypass a restricted
  // Control allowlist through company goals, insight text or an old plan title.
  if (ctx.access.canReadFinancialData && ctx.access.canReadTeamData && (!Array.isArray(ctx.access.allowedActions) || !ctx.access.allowedActions.length)
    && ["owner", "director", "sales_lead"].includes(ctx.auth.activeMembership!.role)) {
    blocks.push(...homeBriefingBlocks(await getBusinessHomeFocus(db, ctx.auth, now), lang));
  }
  if (initialVersion !== accessVersion(await executor.authorize())) throw new ApiError(403, "access_changed", "Права изменились. Сводка не отправлена.");
  const header = `${title}\n${now.toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU", { timeZone: tz, dateStyle: "short", timeStyle: "short" })} · ${tz}`;
  const footer = `${w("Подробнее и следующие шаги", "Толығырақ және келесі қадамдар")}:\n${controlLink("/today")}`;
  const result = [header]; let shortened = false;
  for (const block of blocks) {
    if ([...result, block, footer].join("\n\n").length > 3650) { shortened = true; continue; }
    result.push(block);
  }
  if (!blocks.length) result.push(w("Нет разрешённых данных для сводки. Проверьте доступ Control.", "Қорытынды үшін рұқсат етілген деректер жоқ. Control рұқсатын тексеріңіз."));
  if (shortened) result.push(w("Часть деталей доступна по ссылке ниже.", "Кейбір мәліметтер төмендегі сілтемеде."));
  return [...result, footer].join("\n\n");
}
