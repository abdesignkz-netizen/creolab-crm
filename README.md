# CREOLAB AI CRM

Независимое ядро CRM: компании, роли, заявки с обязательным телефоном, сделки, задачи, уведомления. WhatsApp и текущий ИИ-менеджер подключаются адаптером и **не являются условием работы кабинета**.

Текущий продавец остаётся в `~/Documents/CreoLab/whatsap ai`. CRM не вызывает Green API напрямую и не заменяет управление менеджера из WhatsApp.

## Требования

- Node.js 22+ (проверено 24.18.0)
- npm 11+
- PostgreSQL 16 в проде (Docker Compose). Локально без Docker используется PGlite.

## Установка

```bash
cp .env.example .env
npm install
npm run db:generate
npm run db:seed
```

Если `DATABASE_URL` пустой, данные пишутся в `data/pglite`.

## Запуск

```bash
npm run dev          # API :4100
npm run dev:web      # кабинет :5173
npm run dev:worker   # outbox / расписание
npm run dev:mobile   # Expo
npm test
```

Вход seed (вымышленные ящики, без телефона):

- `owner@creolab.example` / `ChangeMeLocal1!`
- `sales@creolab.example` / `ChangeMeLocal1!`
- `manager@creolab.example` / `ChangeMeLocal1!`
- `owner@demo-agency.example` / `ChangeMeLocal1!`
- `platform@creolab.example` / `ChangeMeLocal1!`

## Форма без WhatsApp

`POST /public/forms/frm_creolab_site_demo/submissions`

```json
{ "name": "Клиент", "phone": "+77010000011", "message": "Нужен сайт" }
```

Пустой/некорректный телефон → `422`. Успех не раскрывает, был ли контакт в базе.

## Подключение текущего WhatsApp ИИ

1. В боте задать `CRM_BRIDGE_SECRET` (и опционально `CRM_EVENTS_URL=http://127.0.0.1:4100/api/v1/integrations/seller-events`).
2. В CRM задать `WHATSAPP_SELLER_URL` (например `http://127.0.0.1:3000`) и тот же `WHATSAPP_SELLER_SECRET`.
3. Проверить `GET /api/v1/integrations/whatsapp-seller/health`.
4. Не переключать Green API webhook на CRM, пока бот отвечает. Иначе два продавца.

Кабинет «Взять диалог» / «Вернуть ИИ» вызывает тот же `SET_MODE`, что и WhatsApp-команды менеджера. Отправка текста идёт через `whatsappService.js`.

## Документы

- `docs/implementation-audit.md`
- `docs/implementation-plan.md`
- `docs/integrations.md`
- `docs/notifications.md`
- `docs/mobile-release.md`
- `docs/deployment.md`
- `docs/acceptance-report.md`
- `apps/api/openapi.yaml`
