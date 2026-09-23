import { CATALOG_BY_CODE, CONTROL_ACTION_META } from "@creolab/contracts";

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "auth.login": "Вход в аккаунт", "auth.login_failed": "Неудачная попытка входа", "auth.logout": "Выход из аккаунта", "auth.logout_all": "Завершены все сеансы",
  "auth.password_reset_requested": "Запрошено восстановление пароля", "auth.password_reset_verified": "Подтверждено восстановление пароля", "auth.password_reset_completed": "Пароль восстановлен",
  "auth.register_started": "Начата регистрация", "auth.register_completed": "Регистрация завершена",
  "company.created": "Добавлена компания", "company.updated": "Изменены данные компании",
  "contact.delete": "Удалён клиент", "contact.merge": "Объединены клиенты", "contact.update": "Изменены данные клиента",
  "deal.create": "Создана сделка", "deal.update": "Изменена сделка", "deal.stage_changed": "Изменён этап сделки", "deal.lost": "Сделка проиграна", "deal.won": "Сделка выиграна",
  "conversation.take": "Диалог передан менеджеру", "conversation.return_to_ai": "Диалог возвращён AI-менеджеру", "conversation.pause": "Диалог поставлен на паузу", "conversation.assign": "Назначен ответственный за диалог", "conversation.instruction": "Добавлено указание по диалогу",
  "inquiry.convert": "Заявка преобразована в сделку",
  "contract.create_draft": "Создан черновик договора", "contract.delete": "Удалён договор", "contract.from_template": "Договор создан по шаблону", "contract.generate": "Сформирован договор", "contract_template.create": "Добавлен шаблон договора",
  "invoice.create_draft": "Создан черновик счёта", "invoice.generate_pdf": "Сформирован PDF счёта", "invoice.update_draft": "Изменён черновик счёта",
  "document.import_pdf": "Загружен документ", "document.restore_requisites": "Восстановлены реквизиты документа",
  "electronic_document.create_draft": "Создан черновик электронного документа", "electronic_document.edit_draft": "Изменён черновик электронного документа", "electronic_document.validate": "Проверен электронный документ", "electronic_document.esf_send": "Отправлен электронный документ в ИС ЭСФ", "electronic_document.esf_send_ncalayer": "Отправлен электронный документ с ЭЦП",
  "esf.connection.connect": "Подключена ИС ЭСФ", "esf.connection.disconnect": "Отключена ИС ЭСФ", "legal_profile.update": "Обновлены реквизиты компании",
  "settings.ops_updated": "Обновлены настройки продаж и сроков", "settings.ai_updated": "Обновлены настройки AI-менеджера", "settings.platform_updated": "Обновлены настройки сервиса",
  "control.settings_updated": "Обновлены настройки BasQar Control", "control.access_updated": "Обновлён доступ к BasQar Control", "control.identity_linked": "Привязан аккаунт BasQar Control", "control.identity_disabled": "Отключена привязка BasQar Control", "control.identity_verified": "Подтверждена привязка BasQar Control",
  "member.invited": "Приглашён сотрудник", "member.invite_resent": "Обновлена ссылка приглашения", "member.invite_revoked": "Приглашение отменено", "member.invite_accepted": "Сотрудник присоединился к компании", "member.sessions_revoked": "Завершены сеансы сотрудника", "member.role_changed": "Изменена роль сотрудника", "member.suspended": "Доступ сотрудника приостановлен", "member.restored": "Доступ сотрудника восстановлен", "member.updated": "Изменены данные сотрудника",
  "payment.confirm": "Оплата подтверждена", "payment.confirmed": "Оплата подтверждена",
  "subscription.activated": "Тариф подключён", "subscription.free_activated": "Подключён бесплатный тариф", "subscription.expired": "Срок подписки истёк", "subscription.extended": "Подписка продлена", "subscription.reactivated": "Подписка возобновлена", "subscription.suspended": "Подписка приостановлена",
  "subscription_request.created": "Создана заявка на изменение тарифа", "subscription_request.cancelled": "Заявка на тариф отменена", "subscription_request.rejected": "Заявка на тариф отклонена",
  "signup_request.created": "Получена заявка на подключение", "support.ticket.created": "Создано обращение в поддержку",
  "admin_override.added": "Изменены индивидуальные условия компании", "billing.free_policy_updated": "Обновлены условия бесплатного тарифа",
  "integration.connected": "Подключена интеграция", "integration.updated": "Обновлены настройки интеграции", "integration.secret_rotated": "Обновлён ключ подключения",
  "integration.meta_access_updated": "Обновлён доступ Meta", "integration.telegram_access_updated": "Обновлён доступ Telegram", "integration.telegram_connected": "Подключён Telegram", "integration.telegram_disconnected": "Отключён Telegram", "integration.tiktok_configured": "Настроен TikTok", "integration.tiktok_disconnected": "Отключён TikTok", "integration.whatsapp.disconnect": "Отключён WhatsApp",
  "seller.mode_sync_failed": "Не удалось обновить режим AI-менеджера",
  "KNOWLEDGE_CREATED": "Добавлен материал базы знаний", "KNOWLEDGE_UPDATED": "Обновлён материал базы знаний", "KNOWLEDGE_PUBLISHED": "Опубликован материал базы знаний", "KNOWLEDGE_DELETED": "Удалён материал базы знаний",
};
for (const [action, meta] of Object.entries(CONTROL_ACTION_META)) AUDIT_ACTION_LABELS[`control.${action.toLowerCase()}`] = `BasQar Control: ${meta.label}`;
for (const [code, label] of Object.entries({ telegram_bot: "Telegram", instagram_direct: "Instagram Direct", meta_lead_forms: "Формы Meta", google_forms: "Google Forms", google_calendar: "Календарь Google", gmail: "Входящая почта", incoming_email: "Входящая почта" })) {
  for (const [suffix, verb] of Object.entries({ connected: "Подключение", configured: "Настройка", disconnected: "Отключение" })) AUDIT_ACTION_LABELS[`integration.${code}_${suffix}`] = `${verb}: ${label}`;
}
export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  PendingRegistration: "Регистрация", ServiceSignupRequest: "Заявка на подключение", agreement: "Договорённость", ai_configuration: "Настройки AI", billing_override: "Индивидуальные условия", billing_payment: "Оплата тарифа", payment: "Оплата", contact: "Клиент", company: "Компания", contract: "Договор", contract_template: "Шаблон договора", control_access: "Доступ к BasQar Control", control_command: "BasQar Control", control_identity: "Аккаунт BasQar Control", conversation: "Диалог", deal: "Сделка", electronic_document: "Электронный документ", esf_connection: "Подключение ИС ЭСФ", inquiry: "Заявка", integration: "Интеграция", invitation: "Приглашение сотрудника", invoice: "Счёт", knowledge_document: "База знаний", membership: "Сотрудник", platform_setting: "Настройки сервиса", service_category: "Услуги и товары", session: "Сеанс", subscription: "Подписка", subscription_request: "Заявка на тариф", support_ticket: "Обращение в поддержку", tenant: "Компания", tenant_legal_profile: "Реквизиты компании", tenant_plan: "Тариф", user: "Пользователь", task: "Задача",
};
const VALUES: Record<string, string> = {
  owner: "Администратор компании", director: "Директор", sales_lead: "Руководитель продаж", manager: "Менеджер", platform_admin: "Администратор сервиса",
  NEW_SUBSCRIPTION: "Подключение тарифа", UPGRADE: "Переход на старший тариф", DOWNGRADE: "Переход на младший тариф", RENEWAL: "Продление", ADD_ADDON: "Подключение дополнения", REMOVE_ADDON: "Отключение дополнения", ENTERPRISE_REQUEST: "Индивидуальный тариф",
  MONTHLY: "Месяц", YEARLY: "Год", monthly: "Месяц", yearly: "Год",
  WHATSAPP: "WhatsApp", whatsapp: "WhatsApp", TELEGRAM: "Telegram", telegram: "Telegram", WEB: "Веб-интерфейс", web: "Веб-интерфейс", CRM: "CRM", email: "Электронная почта",
  platform_admin_payment: "Оплату подтвердил администратор сервиса", manual: "Вручную", trusted: "Подтверждённое подключение", link_created: "Создана ссылка приглашения",
  ok: "Выполнено", success: "Выполнено", error: "Не выполнено", failed: "Не выполнено", denied: "Доступ запрещён", pending_confirmation: "Ожидает подтверждения", confirmed: "Подтверждено", rejected: "Отклонено", cancelled: "Отменено",
  active: "Активен", inactive: "Неактивен", pending: "Ожидает подтверждения", suspended: "Приостановлен", expired: "Срок истёк", disabled: "Отключён",
  open: "Открыто", in_progress: "В работе", waiting: "Ожидание", done: "Завершено", canceled: "Отменено", new: "Новое", won: "Выиграна", lost: "Проиграна",
  unpaid: "Не оплачен", paid: "Оплачен", partial: "Частично оплачен", not_issued: "Не выставлен", issued: "Выставлен", overdue: "Просрочен",
  ai: "AI-менеджер", human: "Менеджер", paused: "На паузе", today: "Сегодня", yesterday: "Вчера", week: "Неделя", month: "Месяц", all: "Всё время", high: "Высокий", normal: "Обычный", low: "Низкий",
};
const FIELDS: Record<string, string> = {
  planCode: "Тариф", fromPlanCode: "Предыдущий тариф", role: "Роль", email: "Электронная почта", name: "Имя", title: "Название", jobTitle: "Должность", type: "Тип заявки", billingPeriod: "Период оплаты", amount: "Сумма", amountMinor: "Сумма", offerAmountMinor: "Сумма сделки", wonAmountMinor: "Сумма выигранной сделки", startsAt: "Начало действия", endsAt: "Действует до", expiresAt: "Действует до", nextActionAt: "Срок следующего действия", dueAt: "Срок", wonAt: "Дата выигрыша", lostAt: "Дата закрытия", nextAction: "Следующее действие", probability: "Вероятность", paymentStatus: "Оплата", status: "Состояние", result: "Результат", source: "Источник", mode: "Режим диалога", delivery: "Приглашение", period: "Период", priority: "Приоритет", active: "Доступ включён", existingUser: "Существующий аккаунт", lossReason: "Причина проигрыша", reason: "Причина", from: "Было", to: "Стало", fileName: "Файл", documentNumber: "Номер документа", number: "Номер", count: "Количество", quantity: "Количество",
};
const FREE_TEXT = new Set(["name", "title", "jobTitle", "email", "nextAction", "lossReason", "reason", "fileName", "documentNumber", "number", "from", "to"]);
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export function presentAudit(item: { action: string; entityType: string; changesJson?: unknown }, timeZone = "Asia/Almaty") {
  const format = (key: string, value: unknown): string | null => {
    if (value == null || value === "" || value === "[REDACTED]") return null;
    if (typeof value === "boolean") return value ? "Да" : "Нет";
    if (key.endsWith("At") && (typeof value === "string" || value instanceof Date)) {
      const date = new Date(value); if (!Number.isFinite(date.getTime())) return null;
      return new Intl.DateTimeFormat("ru-RU", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", ...(key === "nextActionAt" || key === "dueAt" ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(date);
    }
    if (["amount", "amountMinor", "offerAmountMinor", "wonAmountMinor"].includes(key)) return Number.isFinite(Number(value)) ? `${Number(value).toLocaleString("ru-RU")} ₸` : null;
    if (key === "planCode" || key === "fromPlanCode") return CATALOG_BY_CODE[String(value)]?.name || "Индивидуальный тариф";
    if (typeof value === "number") return `${value.toLocaleString("ru-RU")}${key === "probability" ? "%" : ""}`;
    if (typeof value !== "string") return null;
    if (VALUES[value]) return VALUES[value];
    if (FREE_TEXT.has(key)) {
      // Technical identifiers/errors are not a useful description, even in a text field.
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) || /^(?:\{|\[)|\b(?:Error|Exception|stack|SELECT|INSERT)\b/.test(value)) return null;
      return value.slice(0, 300);
    }
    return null;
  };
  const details: string[] = [];
  const changes = record(item.changesJson);
  const before = record(changes.before); const after = record(changes.after);
  for (const [key, value] of Object.entries(after)) {
    if (!FIELDS[key] || JSON.stringify(before[key]) === JSON.stringify(value)) continue;
    const old = format(key, before[key]); const next = format(key, value);
    if (old || next) details.push(`${FIELDS[key]}: ${old || "не указано"} → ${next || "не указано"}`);
  }
  for (const [key, value] of Object.entries({ ...changes, ...record(changes.params) })) {
    if (!FIELDS[key]) continue;
    const text = format(key, value); if (text) details.push(`${FIELDS[key]}: ${text}`);
  }
  if (changes.error) details.push("Действие не выполнено. Обратитесь в поддержку, если ошибка повторяется.");
  const entityLabel = AUDIT_ENTITY_LABELS[item.entityType] || "Система";
  return { actionLabel: AUDIT_ACTION_LABELS[item.action] || `Действие: ${entityLabel.toLocaleLowerCase("ru")}`, entityLabel, details: [...new Set(details)].slice(0, 10) };
}
