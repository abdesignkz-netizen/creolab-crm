/** Operational evidence, never a probability of losing a sale. */
export type DealRiskCode = "reply_waiting" | "execution_uncertain" | "task_overdue" | "step_overdue" | "owner_missing"
  | "step_missing" | "deadline_missing" | "proposal_unanswered" | "stage_overdue" | "payment_check" | "on_hold";
export type DealRiskSignal = {
  code: DealRiskCode;
  urgency: "urgent" | "attention";
  source: "deal" | "task" | "conversation" | "invoice";
  sourceId: string;
  at: string | null;
  thresholdDays?: number;
  elapsedDays?: number;
};
export type DealRisk = {
  priority: "urgent" | "attention" | "clear" | "on_hold";
  checkedAt: string;
  timeBasis: "calendar" | "business";
  signals: DealRiskSignal[];
  fingerprint: string;
  recommendation: null | {
    kind: "task" | "conversation" | "deal" | "create_task";
    title: string;
    titleFromRecord: boolean;
    reason: DealRiskCode;
    href: string;
    dueAt: string | null;
    deadlineBasis: "existing" | "suggested" | "none";
    ownerMembershipId: string | null;
    ownerName: string | null;
    canCreate: boolean;
  };
};
export const DEAL_RISK_LABELS: Record<DealRiskCode, readonly [string, string]> = {
  reply_waiting: ["Клиент ждёт ответа сотрудника", "Клиент қызметкердің жауабын күтуде"],
  execution_uncertain: ["Результат задачи не подтверждён", "Тапсырма нәтижесі расталмады"],
  task_overdue: ["Просрочена связанная задача", "Байланысты тапсырманың мерзімі өтті"],
  step_overdue: ["Просрочено следующее действие", "Келесі әрекеттің мерзімі өтті"],
  owner_missing: ["Не назначен действующий ответственный", "Белсенді жауапты қызметкер тағайындалмаған"],
  step_missing: ["Нет следующего действия", "Келесі әрекет жоқ"],
  deadline_missing: ["Не указан срок следующего шага", "Келесі қадамның мерзімі көрсетілмеген"],
  proposal_unanswered: ["Предложение осталось без ответа", "Ұсыныс жауапсыз қалды"],
  stage_overdue: ["Просрочен срок этапа", "Кезеңнің мерзімі өтті"],
  payment_check: ["Нужно проверить оплату счёта", "Шот төлемін тексеру қажет"],
  on_hold: ["Сделка на паузе", "Мәміле кідіртілген"],
};
export const DEAL_RISK_ACTIONS: Record<DealRiskCode, readonly [string, string]> = {
  reply_waiting: ["Проверить переписку и ответить клиенту", "Хат алмасуды тексеріп, клиентке жауап беру"],
  execution_uncertain: ["Проверить результат выполнения задачи", "Тапсырманың орындалу нәтижесін тексеру"],
  task_overdue: ["Проверить просроченную задачу", "Мерзімі өткен тапсырманы тексеру"],
  step_overdue: ["Уточнить результат и срок следующего шага", "Келесі қадамның нәтижесі мен мерзімін нақтылау"],
  owner_missing: ["Назначить ответственного за сделку", "Мәмілеге жауапты қызметкер тағайындау"],
  step_missing: ["Согласовать следующий шаг с клиентом", "Клиентпен келесі қадамды келісу"],
  deadline_missing: ["Указать срок следующего шага", "Келесі қадамның мерзімін көрсету"],
  proposal_unanswered: ["Уточнить решение клиента по предложению", "Клиенттің ұсыныс бойынша шешімін нақтылау"],
  stage_overdue: ["Уточнить препятствие и следующий шаг по сделке", "Мәміледегі кедергі мен келесі қадамды нақтылау"],
  payment_check: ["Проверить поступление оплаты по счёту", "Шот бойынша төлемнің түсуін тексеру"],
  on_hold: ["Проверить причину паузы и дату возврата", "Кідіріс себебі мен қайта оралу күнін тексеру"],
};
export const dealRiskLabel = (code: DealRiskCode, lang = "ru") => DEAL_RISK_LABELS[code]?.[lang === "kk" ? 1 : 0] || code;
export const dealRiskAction = (code: DealRiskCode, lang = "ru") => DEAL_RISK_ACTIONS[code]?.[lang === "kk" ? 1 : 0] || code;
