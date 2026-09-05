# Аудит реализации CREOLAB AI CRM

Дата: 6 сентября 2026  
Версия ТЗ: 1.2  
Рабочее название: CREOLAB AI CRM

Документ фиксирует фактическое состояние до изменений. Секреты, ключи и реальные переписки не копируются.

## 1. Что открыто

| Репозиторий | Путь | Состояние |
| --- | --- | --- |
| Новый кабинет CRM | `/Users/ashat/Documents/CreoLab/CRM CREOLAB` | Пустая папка на момент аудита. Кода CRM, README, Docker, миграций нет. |
| Рабочий WhatsApp ИИ-менеджер | `/Users/ashat/Documents/CreoLab/whatsap ai` | Живой Node.js/Express-проект. Это единственный существующий продавец. |
| Устаревший stub | `/Users/ashat/Documents/CreoLab/whatsap ai/whatsapp-ai-manager` | Отдельный Express 4 + `/test-ai`. Webhook, Green API и управление менеджера отсутствуют. Не запускать как прод. |

Открытый репозиторий CRM бота не содержал. Перенос конкретного бота внутрь CRM **не выполнялся**: бот остаётся отдельным процессом. CRM подключается к нему адаптером.

## 2. Стек существующего бота

| Пункт | Факт |
| --- | --- |
| Пакетный менеджер | npm (`package-lock.json`) |
| Модули | ESM (`"type": "module"`) |
| Runtime | Node.js 24.18.0 на машине разработки; зависимости Express 5, cors, dotenv, multer, openai |
| Скрипты | `dev`/`start` → `node server.js`; `test` → `node --test` на 7 файлах; `eval:ai-manager` |
| ORM / PostgreSQL / Redis / Docker / миграции | Нет |
| Веб-кабинет / мобильное приложение / авторизация | Нет |
| Хранение | JSON-файлы в `DATA_DIR` (по умолчанию `./data`) |
| Тесты | greeting, AI JSON, assistant actions, voice, management control, outbound guard, prelaunch mocks |

## 3. Единственный путь отправки сообщений

Все исходящие WhatsApp идут через `/Users/ashat/Documents/CreoLab/whatsap ai/services/whatsappService.js`.

| Функция | Green API |
| --- | --- |
| `sendWhatsAppMessage` | `sendMessage` |
| `sendWhatsAppFile` | `sendFileByUrl` |
| `sendWhatsAppLocalFile` | `sendFileByUpload` |
| `sendManagerMessage` | обёртка над `sendWhatsAppMessage` на чат менеджера |
| `checkWhatsAppNumber` | `checkWhatsapp` |

База: `https://7107.api.greenapi.com/waInstance{idInstance}`.  
Переменные: `GREEN_API_INSTANCE_ID`, `GREEN_API_TOKEN`.  
Продукт: обычный Green API (не WABA Cloud API). Тариф Developer ограничивает число открытых чатов.

**Правило миграции:** CRM не создаёт второй Green API sender. Пока бот живой, отправка клиенту — только через этот модуль (внутренний мост CRM → бот).

## 4. Входящие и буфер

Рабочая точка входа: `server.js`.

- `POST /webhook` сразу отвечает `{ success: true, accepted: true }` и обрабатывает тело асинхронно.
- Типы: `incomingMessageReceived`, `outgoingMessageStatus`.
- Проверки подписи webhook **нет**.
- Буфер: in-memory `pendingMessages` по `chatId`. `MESSAGE_BUFFER_MS` по умолчанию 2000 (в `.env.example`). ТЗ допускает 1–15 с, верх серии 20 с.
- Защита от повтора входящих: последние 80 `idMessage` на сессию, in-memory.
- Новое сообщение во время генерации увеличивает `version` и отменяет устаревший ответ.

Маршруты помимо webhook:

- `GET /` — health JSON
- `POST /api/lead` — форма сайта → Telegram (honeypot `website`). Это **не** CRM-заявка и не создаёт лид в `leads.json`.
- `POST /test-ai` — песочница модели без WhatsApp

## 5. Управление менеджера и ИИ-менеджера

Связка живая и не должна ломаться.

### Операционные команды WhatsApp (`managerService.js`)

Сообщения с номеров `SALES_MANAGER_WHATSAPP` / `MANAGER_PHONE` / `MANAGER_CHAT_ID` идут в `handleManagerMessage`, не в клиентский продавец.

Режимы лида: `AUTO` | `CONTROLLED` | `HUMAN` | `PAUSED`.  
Команды: пауза/продолжить/забрать себе, точный текст, черновик ИИ с подтверждением «да/отправь», статус, список лидов, рассылка, файл, мин. цена, цель, инструкция.

Подтверждение исходящих: `managerSession.js` (`pendingOutbound`, TTL 30 мин).

### Управляющий слой (`managementControl.js`)

Флаг `MANAGEMENT_WHATSAPP_CONTROL_ENABLED` (в примере `false`).  
При включении: правила скидок, пауза, handoff, one-off, запросы статуса.  
Хранение: `data/management_instructions.json`.  
Перед отправкой клиенту: `assertClientSendAllowed()`.

CRM не заменяет этот канал. Кабинет может зеркалировать режим (`ai`/`human`/`paused` ↔ `AUTO`/`HUMAN`/`PAUSED`) через тот же `updateLead` / `addManagerInstruction`.

## 6. ИИ

- Провайдер: `AI_PROVIDER=ANYMODEL` или OpenAI. Провайдер **не меняем**.
- Промпт: `prompts/system_prompt.txt`
- Знания: `knowledge/creolab_knowledge_base.txt`
- Ответ валидируется `aiReplyParser.js` (обязателен непустой `reply`)
- Повторы: `isSimilarReply()` + антиповтор в промпте
- Приветствие: `greetingState.js`, не чаще первого успешного исходящего
- Голос: транскрипция при рабочем провайдере, иначе fallback человеку/текстом
- Timeout/контекст: `MAX_HISTORY_MESSAGES` в примере 8; в коде запасной default 40

## 7. Данные бота

| Файл | Содержимое |
| --- | --- |
| `leads.json` | `{ counter, leads, phoneIndex }` — телефон нормализованный 11-значный является ключом индекса |
| `manager-session.json` | черновики и last focus менеджера |
| `management_instructions.json` | правила руководителя |

In-memory и теряется при рестарте: буфер webhook, locks, abort-gate, статусы исходящих, greeting reserve.

Идентичность клиента в боте — телефон. Компания зашита как CREOLAB. Multi-tenant нет.

## 8. Привязка к телефонам — разрыв с ТЗ CRM

В боте допустимо: телефон как ключ лида, роль менеджера по whitelist номеров, `chatId = phone@c.us`.

В ядре CRM **запрещено**:

- `phone` как PK контакта/компании
- `if (phone === OWNER_PHONE)` и сценарии по номеру
- tenant routing по WhatsApp-номеру
- обязательный телефон у сотрудника

Телефон клиента — обязательное поле полноценной заявки, не идентификатор сущности.

## 9. Переменные окружения бота (только имена)

Из `.env.example`: `AI_PROVIDER`, `OPENAI_*`, `ANYMODEL_*`, `MESSAGE_BUFFER_MS`, `MAX_HISTORY_MESSAGES`, `BROADCAST_*`, `PORT`, `DATA_DIR`, `MANAGER_PHONE`, `MANAGER_CHAT_ID`, `SALES_MANAGER_WHATSAPP`, `PRESENTATION_KP_PATH`, `MANAGEMENT_WHATSAPP_CONTROL_ENABLED`, `MANAGEMENT_CONTROLLER_PHONES`, `MANAGER_ALIASES`, `GREEN_API_INSTANCE_ID`, `GREEN_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Используются в коде, но не в примере: `FLUSH_TIMEOUT_MS`, `GREEN_API_TIMEOUT_MS`, `VOICE_TRANSCRIBE_MS`, `FRONTEND_ORIGIN`, `RENDER_EXTERNAL_URL`, `KEEP_ALIVE_URL`, `BOT_PHONE`, `GREEN_API_PHONE`, `GREEN_API_WID`.

## 10. Точки подключения CRM

| Сохраняем без переписывания | Подключаем адаптером |
| --- | --- |
| `server.js` webhook + буфер | События лида/сообщений → CRM outbox/inbound |
| `whatsappService.js` как единственный sender | CRM send → внутренний API бота |
| `handleManagerMessage` + management control | CRM take/return AI → тот же `SET_MODE` |
| `aiService` + промпт/знания | Песочница CRM не шлёт в WhatsApp |
| `POST /api/lead` сайта → Telegram | Отдельный приём форм CRM (`Inquiry`) без WhatsApp |

Рекомендуемый порядок владельца отправки:

1. Сейчас и на этапе 4: процесс бота.
2. CRM-worker не вызывает Green API напрямую.
3. Переключение webhook на CRM — только после контрольной точки и отключения автоответа бота. Иначе два продавца.

## 11. Выбранный стек CRM

Совместим с ботом и ТЗ:

- Node.js 24 LTS, npm workspaces
- Backend: Express + TypeScript
- БД: PostgreSQL + Prisma
- Очередь: Redis + BullMQ
- Web: React + TypeScript + Vite + Tailwind
- Mobile: React Native + Expo + TypeScript + Expo Router
- Контракты: Zod в `packages/contracts`
- Файлы: локальный каталог в dev, S3-совместимый контракт на потом

## 12. Миграционный план данных бота

1. Резервная копия `DATA_DIR` до любого импорта.
2. Каждому лиду — внутренние UUID `contact_id`, `conversation_id`; телефон → `ContactMethod` + `ExternalIdentity` в scope подключения.
3. `LEAD-NNNN` и `chatId` сохраняются как внешние ID, не как PK CRM.
4. История помечается `historical`; старые ответы и follow-up не переигрываются.
5. Лиды без валидного телефона (если встретятся `@lid` без номера) → `IncompleteIntake`, не полноценная заявка.
6. Импорт не выполняется скрыто из seed/тестов и не шлёт сообщения клиентам.

**Статус импорта на момент этапа 0:** не выполнялся. Живых данных бота CRM не читает, пока не включён мост.

## 13. Проверки аудита

| Проверка | Результат |
| --- | --- |
| Живой entrypoint | `whatsap ai/server.js`, не `whatsapp-ai-manager/` |
| Единственный send-path | `whatsappService.js` |
| Управление менеджера | WhatsApp → `handleManagerMessage` (+ optional `managementControl`) |
| CRM-репозиторий | пуст |
| Docker / Postgres локально | Docker в PATH на момент проверки не ответил; `psql`/`createdb` нет |
| Секреты в этот документ | не копировались |

## 14. Реальные ограничения

- Горизонтальное масштабирование бота невозможно без выноса буфера/locks из памяти.
- Webhook бота без токена.
- Форма сайта пишет в Telegram, не в лиды и не в CRM.
- `phoneIndex` бота не переносится в ядро CRM как уникальный ключ.
- Green API Developer: ограниченный список чатов; WABA/Cloud API нет.
- Живой тест WhatsApp в этой среде не запускался (нет права слать реальным клиентам из разработки).
