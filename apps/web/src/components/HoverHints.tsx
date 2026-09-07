import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ACTION_HINTS: Record<string, string> = {
  "Войти": "Войти в CRM с указанными почтой и паролем",
  "Скрыть": "Свернуть открытую форму или панель",
  "Распознать список": "Найти телефонные номера во введённом списке",
  "Обновить выборку": "Заново найти клиентов по выбранным условиям",
  "Сгенерировать черновик": "Подготовить текст сообщения по вашему описанию",
  "Создать черновик рассылки": "Сохранить рассылку для дальнейшей подготовки",
  "Удалить": "Удалить выбранный элемент",
  "Сейчас": "Выбрать отправку сразу после подтверждения",
  "Запланировать": "Выбрать дату и время отправки",
  "Подготовить черновик": "Подготовить содержимое для проверки",
  "Проверить и подготовить": "Проверить получателей и содержимое перед подтверждением",
  "Вернуться и изменить": "Вернуться к редактированию до отправки",
  "Приостановить": "Приостановить выполнение",
  "Отменить остаток": "Отменить ещё не выполненную часть рассылки",
  "Повторить для неуспешных": "Повторить отправку получателям, для которых произошла ошибка",
  "+ Компания": "Открыть форму добавления компании",
  "Всё равно создать": "Создать отдельную запись несмотря на найденные совпадения",
  "Добавить контакт": "Найти контакт и связать его с компанией",
  "Редактировать": "Открыть данные для изменения",
  "Добавить заметку": "Добавить запись в историю клиента",
  "Добавить тег": "Добавить метку для поиска и группировки клиента",
  "Архивировать": "Перенести клиента в архив",
  "Добавить": "Добавить заполненный элемент",
  "Связать с компанией": "Выбрать компанию для этого клиента",
  "Приостановить AI": "Приостановить автоматические ответы AI",
  "Возобновить AI": "Снова включить автоматические ответы AI",
  "Забрать все диалоги у AI": "Открыть подтверждение передачи всех диалогов менеджерам",
  "Забрать все": "Передать все выбранные диалоги менеджерам",
  "Забрать себе": "Взять диалог на себя и остановить ответы AI",
  "Забрать": "Передать диалог менеджеру",
  "Передать AI": "Снова поручить ответы в диалоге AI",
  "Понять контекст": "Проанализировать переписку и выделить потребность и договорённости",
  "Проверить подключение": "Проверить доступность и состояние интеграции",
  "Сохранить и проверить": "Сохранить настройки и проверить подключение",
  "Забрать диалоги из бота": "Загрузить диалоги подключённого бота в CRM",
  "Взять в работу": "Назначить заявку себе и начать обработку",
  "Создать сделку": "Создать сделку на основе заявки",
  "+ Создать сделку": "Открыть создание сделки на основе заявки",
  "Подтвердить": "Подтвердить указанное действие",
  "Повторить анализ": "Повторно проанализировать заявку с помощью AI",
  "Сбросить фильтры": "Очистить дополнительные условия отбора",
  "Использовать клиента": "Привязать заявку к найденному клиенту",
  "Создать заявку": "Сохранить новую заявку с заполненными данными",
  "Только важное": "Показать события, требующие внимания",
  "Открыть воронку": "Показать этапы продаж и переходы между ними",
  "CSV источников": "Скачать таблицу источников в формате CSV",
  "PDF": "Скачать отчёт в формате PDF",
  "Excel": "Скачать отчёт в формате Excel",
  "CSV воронки": "Скачать таблицу воронки в формате CSV",
  "Убрать": "Убрать выбранный элемент из текущего списка",
  "Добавить номер": "Добавить введённый телефон в список получателей",
  "Понять задачу": "Разобрать описание и подготовить параметры задачи",
  "Очистить": "Очистить введённые данные",
  "Выбрать всех": "Выбрать всех клиентов из текущего списка",
  "Изменить": "Вернуться к редактированию параметров",
  "Подтвердить и отправить": "Отправить подготовленное сообщение выбранным получателям",
  "Повторить отправку файла": "Повторить неудавшуюся отправку вложения",
  "Изменить клиента": "Выбрать другого клиента для задачи",
  "Показать клиентов": "Найти клиентов по выбранным условиям",
  "Удалить файл": "Убрать вложение из подготовленного сообщения",
  "Без следующего действия": "Закрыть выбор следующего шага без создания задачи",
  "Завершить задачу": "Зафиксировать результат и завершить задачу",
  "Сделано": "Отметить задачу выполненной",
  "Повторить файл": "Повторить отправку вложения",
  "Найти": "Найти записи по введённому имени, телефону или тексту",
  "Фильтры": "Показать или скрыть дополнительные условия отбора",
  "Все": "Показать все записи с учётом выбранных фильтров",
  "Новые": "Показать записи со статусом «Новый»",
  "В работе": "Показать записи, которые сейчас находятся в работе",
  "Нужен ответ": "Показать клиентов, ожидающих ответа на сообщение",
  "Просрочено": "Показать записи с пропущенным сроком действия",
  "Без следующего шага": "Показать активные заявки без задачи и следующего действия",
  "+ Клиент": "Открыть или скрыть форму добавления клиента",
  "Создать": "Сохранить новую запись с заполненными данными",
  "Сохранить": "Сохранить внесённые изменения",
  "Отмена": "Закрыть форму без сохранения изменений",
  "Закрыть": "Закрыть открытое окно или панель",
  "×": "Закрыть открытое окно или панель",
  "✕": "Закрыть открытое окно или панель",
  "Повторить": "Повторить загрузку после ошибки",
  "Обновить": "Загрузить актуальные данные",
  "Подробнее": "Открыть подробности этого блока",
  "Скачать отчёт": "Выбрать формат и скачать отчёт за выбранный период",
  "События периода": "Показать события, произошедшие в выбранном периоде",
  "Когорта обращений": "Проследить воронку обращений, поступивших в выбранном периоде",
};

function hintFor(element: HTMLElement) {
  const explicit = element.dataset.tip || element.getAttribute("title");
  if (explicit) return explicit;
  const label = (element.getAttribute("aria-label") || (element instanceof HTMLInputElement ? element.value : element.textContent) || "").replace(/\s+/g, " ").trim();
  if (element.closest(".nav-links") && element.querySelector(".nav-link-label")) return `Открыть раздел «${element.querySelector(".nav-link-label")?.textContent?.trim()}»`;
  if (ACTION_HINTS[label]) return ACTION_HINTS[label];
  if (element.getAttribute("role") === "tab") return `Показать раздел «${label}»`;
  if (element.matches(".conv-row")) return "Открыть переписку с клиентом";
  if (element.matches(".client-row")) return `Открыть карточку клиента: ${element.querySelector("b")?.textContent || "клиент"}`;
  if (/^\d+$/.test(label)) return "Показать записи, вошедшие в этот показатель";
  if (element.closest(".chip-row, .stats-metric-switch, .sit-tabs")) return `Показать: ${label}`;
  const shortLabel = label.length > 140 ? `${label.slice(0, 137)}…` : label;
  if (element.matches("a")) return `Открыть: ${shortLabel || "связанная запись"}`;
  return shortLabel ? `Действие: ${shortLabel}` : "Открыть доступное действие";
}

/** One tooltip surface for every button, including dynamically loaded panels. */
export function HoverHints() {
  const id = useId();
  const [hint, setHint] = useState<{ element: HTMLElement; text: string } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active: HTMLElement | null = null;
    let originalTitle: string | null = null;
    let originalDescription: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const selector = 'button, a, summary, [role="button"], [role="tab"], input[type="submit"], input[type="button"], [data-tip]';
    function hide() {
      clearTimeout(timer);
      if (active) {
        if (originalTitle !== null) active.setAttribute("title", originalTitle);
        if (originalDescription === null) active.removeAttribute("aria-describedby");
        else active.setAttribute("aria-describedby", originalDescription);
      }
      active = null;
      setHint(null);
    }
    function show(event: Event) {
      if (event instanceof PointerEvent && event.pointerType === "touch") return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (!element || element === active) return;
      hide();
      active = element;
      const text = hintFor(element);
      originalTitle = element.getAttribute("title");
      originalDescription = element.getAttribute("aria-describedby");
      // Avoid a second, native tooltip on top of the styled hint.
      element.removeAttribute("title");
      timer = setTimeout(() => {
        if (!element.isConnected) return hide();
        element.setAttribute("aria-describedby", [originalDescription, id].filter(Boolean).join(" "));
        setHint({ element, text });
      }, event.type === "focusin" ? 0 : 350);
    }
    function leave(event: Event) {
      const related = (event as MouseEvent).relatedTarget;
      if (!(related instanceof Node) || !active?.contains(related)) hide();
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") hide();
    }
    function reposition() {
      if (active && !active.isConnected) return hide();
      setHint((current) => current ? { ...current } : null);
    }
    document.addEventListener("pointerover", show, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", show, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("click", hide, true);
    document.addEventListener("keydown", keydown);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      hide();
      document.removeEventListener("pointerover", show, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", show, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("click", hide, true);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (!hint || !bubble.current) return;
    const anchor = hint.element.getBoundingClientRect();
    const bounds = bubble.current.getBoundingClientRect();
    const above = anchor.top - bounds.height - 8;
    setPosition({
      left: Math.max(8, Math.min(anchor.left + (anchor.width - bounds.width) / 2, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 8, window.innerHeight - bounds.height - 8)),
    });
  }, [hint]);

  return hint ? createPortal(
    <div ref={bubble} id={id} role="tooltip" className="hover-hint" style={position}>{hint.text}</div>,
    document.body,
  ) : null;
}
