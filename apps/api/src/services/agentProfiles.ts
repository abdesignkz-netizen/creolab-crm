import type { ControlAction, ControlProfile, BusinessInsightRule, GoalMetric } from "@creolab/contracts";

type Profile = {
  title: string; topic?: string; reads: Array<{ action: ControlAction; period: boolean; href: string }>;
  rules: BusinessInsightRule[]; goals: GoalMetric[];
  task: string; steps: string[]; href: string;
};
/** Profiles select existing read tools, not independently acting model agents. */
export const CONTROL_PROFILES: Record<ControlProfile, Profile> = {
  business: {
    title: "Обзор бизнеса", reads: [{ action: "GET_BUSINESS_SUMMARY", period: true, href: "/stats" }, { action: "GET_SITUATION", period: false, href: "/today" }],
    rules: ["inquiry_unhandled", "task_overdue", "deal_next_step", "proposal_delayed", "payment_delayed", "sales_plan_risk"], goals: ["sales_won", "overdue_tasks", "first_response_minutes"],
    task: "Определить следующий приоритет компании", steps: ["Сверить актуальные показатели и открытые обращения.", "Выбрать одну проблему, ответственного и срок.", "Зафиксировать ожидаемый результат и проверить его после выполнения."], href: "/today",
  },
  sales: {
    title: "Разбор продаж", topic: "Продажи", reads: [{ action: "GET_DEALS_STATS", period: true, href: "/stats?tab=sales" }, { action: "GET_SALES_CONTROL", period: false, href: "/control?view=sales" }],
    rules: ["deal_next_step", "proposal_delayed", "sales_plan_risk"], goals: ["sales_won"],
    task: "Проверить препятствия в продажах", steps: ["Открыть сделки, требующие участия сотрудника.", "Проверить причины по истории общения, не считать прогноз доказанной причиной.", "Согласовать следующий контакт и срок по выбранной сделке."], href: "/control?view=sales",
  },
  finance: {
    title: "Продажи и поступления", reads: [{ action: "GET_REVENUE_STATS", period: true, href: "/stats?tab=sales" }, { action: "GET_EXPECTED_PAYMENTS", period: true, href: "/deals" }],
    rules: ["payment_delayed"], goals: [],
    task: "Сверить ожидаемые оплаты", steps: ["Сопоставить ожидаемые оплаты с подтверждёнными поступлениями.", "Проверить договор и счёт по выбранной сделке.", "Зафиксировать результат сверки; платежи подтверждать только по факту поступления."], href: "/deals",
  },
  team: {
    title: "Работа команды", topic: "Задачи команды", reads: [{ action: "GET_OVERDUE_TASKS", period: false, href: "/tasks" }, { action: "GET_TEAM_STATUS", period: false, href: "/today" }],
    rules: ["task_overdue"], goals: ["overdue_tasks"],
    task: "Разобрать просроченные задачи команды", steps: ["Проверить актуальность просроченных задач.", "Уточнить препятствия и реальные сроки у ответственных.", "Согласовать следующий шаг; выполненную работу отметить по фактическому результату."], href: "/tasks",
  },
  service: {
    title: "Обработка обращений", topic: "Работа с клиентами", reads: [{ action: "GET_LEADS_STATS", period: true, href: "/requests" }, { action: "GET_SITUATION", period: false, href: "/today" }],
    rules: ["inquiry_unhandled"], goals: ["first_response_minutes"],
    task: "Проверить обращения без ответа", steps: ["Открыть обращения, в которых клиент ждёт ответа.", "Проверить историю диалога и назначенного сотрудника.", "Согласовать ответ и проверить его фактическую доставку клиенту."], href: "/requests",
  },
};

export const CONTROL_ANALYSIS_LIMITS = { reads: 5, timeMs: 30_000, cards: 7, modelCalls: 0 } as const;
