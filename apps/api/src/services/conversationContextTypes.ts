/** Structured analysis produced by Conversation Context Engine. AI suggests; backend applies. */

export type WaitingFor = "CLIENT" | "MANAGER" | "AI" | "THIRD_PARTY" | "NONE";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export type AgreementType =
  | "CALL"
  | "ONLINE_MEETING"
  | "OFFLINE_MEETING"
  | "SEND_PROPOSAL"
  | "SEND_DOCUMENTS"
  | "SEND_CONTRACT"
  | "SEND_INVOICE"
  | "FOLLOW_UP"
  | "MESSAGE"
  | "PAYMENT_PROMISE"
  | "PREPARE_ESTIMATE"
  | "CLIENT_CALLBACK"
  | "MANAGER_CALLBACK"
  | "OTHER";

export type AgreementStatus =
  | "DETECTED"
  | "NEEDS_CLARIFICATION"
  | "CONFIRMED"
  | "SCHEDULED"
  | "COMPLETED"
  | "RESCHEDULED"
  | "CANCELLED"
  | "MISSED";

export type SuggestedAgreement = {
  action: "create" | "update" | "reschedule" | "cancel" | "complete";
  existingAgreementId?: string | null;
  type: AgreementType;
  title: string;
  summary?: string | null;
  purpose?: string | null;
  status: AgreementStatus;
  scheduledAt?: string | null;
  scheduledEndAt?: string | null;
  locationName?: string | null;
  address?: string | null;
  meetingProvider?: string | null;
  meetingUrl?: string | null;
  meetingId?: string | null;
  meetingPassword?: string | null;
  phone?: string | null;
  clarificationNeeded?: string | null;
  confidence: Confidence;
  createTask: boolean;
  taskType?: string | null;
  evidenceMessageIds: string[];
};

export type SuggestedTask = {
  type: string;
  title: string;
  dueAt?: string | null;
  purpose?: string | null;
  briefingText?: string | null;
  preparationHints?: string[];
  linkedAgreementIndex?: number | null;
  evidenceMessageIds: string[];
  confidence: Confidence;
};

export type ConversationAnalysis = {
  clientIntent: string | null;
  detectedNeed: string | null;
  suggestedRequestStatus: string | null;
  suggestedDealStage: string | null;
  waitingFor: WaitingFor;
  needsReply: boolean;
  agreements: SuggestedAgreement[];
  suggestedTasks: SuggestedTask[];
  suggestedNextAction: string | null;
  humanRequired: boolean;
  humanReason: string | null;
  summaryUpdate: string | null;
  evidenceMessageIds: string[];
  confidence: Confidence;
  /** Internal: never show % to users */
  facts: {
    service?: string | null;
    budget?: string | null;
    deadline?: string | null;
    company?: string | null;
    meetingDate?: string | null;
    meetingTime?: string | null;
  };
};

export const AGREEMENT_TYPE_LABEL: Record<AgreementType, string> = {
  CALL: "Телефонный созвон",
  ONLINE_MEETING: "Онлайн-встреча",
  OFFLINE_MEETING: "Личная встреча",
  SEND_PROPOSAL: "Отправить КП",
  SEND_DOCUMENTS: "Отправить документы",
  SEND_CONTRACT: "Отправить договор",
  SEND_INVOICE: "Отправить счёт",
  FOLLOW_UP: "Follow-up",
  MESSAGE: "Написать",
  PAYMENT_PROMISE: "Обещание оплаты",
  PREPARE_ESTIMATE: "Подготовить расчёт",
  CLIENT_CALLBACK: "Клиент перезвонит",
  MANAGER_CALLBACK: "Менеджер перезвонит",
  OTHER: "Другое",
};

export const AGREEMENT_STATUS_LABEL: Record<AgreementStatus, string> = {
  DETECTED: "Обнаружено",
  NEEDS_CLARIFICATION: "Нужно уточнить",
  CONFIRMED: "Подтверждено",
  SCHEDULED: "Запланировано",
  COMPLETED: "Выполнено",
  RESCHEDULED: "Перенесено",
  CANCELLED: "Отменено",
  MISSED: "Пропущено",
};

export const WAITING_FOR_LABEL: Record<WaitingFor, string> = {
  CLIENT: "Ждём клиента",
  MANAGER: "Ждём менеджера",
  AI: "Ждём AI",
  THIRD_PARTY: "Ждём третью сторону",
  NONE: "Никого не ждём",
};

export function agreementTypeToTaskType(type: AgreementType): string {
  switch (type) {
    case "CALL":
    case "MANAGER_CALLBACK":
      return "call";
    case "ONLINE_MEETING":
    case "OFFLINE_MEETING":
      return "meeting";
    case "SEND_PROPOSAL":
      return "proposal";
    case "SEND_DOCUMENTS":
      return "send_documents";
    case "SEND_CONTRACT":
    case "SEND_INVOICE":
      return "send_documents";
    case "FOLLOW_UP":
    case "MESSAGE":
      return "follow_up";
    case "PAYMENT_PROMISE":
      return "payment";
    case "PREPARE_ESTIMATE":
      return "prepare_estimate";
    case "CLIENT_CALLBACK":
      return "wait_client";
    default:
      return "other";
  }
}
