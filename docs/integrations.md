# Интеграции

## Форма сайта

- Маршрут: `POST /public/forms/{publicKey}/submissions`
- Public key — идентификатор, не секрет.
- Обязательные поля: `name`, `phone`. Телефон нельзя сделать необязательным.
- Honeypot: поле `website`.
- Идемпотентность: заголовок `x-submission-id` или стабильный ключ содержимого.
- Ответ нейтральный: `{ ok, receipt }`. Наличие контакта не раскрывается.
- WhatsApp не запускается.

Пример:

```html
<form action="http://localhost:4100/public/forms/frm_creolab_site_demo/submissions" method="post">
  <input name="name" required />
  <input name="phone" required />
  <textarea name="message"></textarea>
  <input name="website" style="display:none" />
</form>
```

## Серверный webhook

`POST /api/v1/integrations/{integrationId}/events`

Заголовки:

- `Authorization: Bearer <секрет>`
- `X-CRM-Timestamp` — unix seconds, окно 300 с
- `X-CRM-Signature` — `hex(HMAC_SHA256(secret, timestamp + '.' + rawBody))`

Тело: см. ТЗ, `event_type=inquiry.created`. Поля `tenant_id`, `role`, `assignee_id` игнорируются.

Без валидного телефона: `202` + `disposition=needs_phone` + `incomplete_intake_id`, без `inquiry_id`.

Повтор того же `event_id` и тела — идемпотентен. Другое тело — `409`.

Ротация: сменить секрет в кабинете, обновить отправителя. Старый ключ после ротации не принимается.

## WhatsApp / текущий бот

Не подключайте второй Green API sender.

| На стороне бота | На стороне CRM |
| --- | --- |
| `CRM_BRIDGE_SECRET` | `WHATSAPP_SELLER_SECRET` |
| `CRM_EVENTS_URL` | `POST /api/v1/integrations/seller-events` |
| процесс `server.js` | `WHATSAPP_SELLER_URL` |

Внутренние маршруты бота (только с секретом):

- `GET /internal/crm/health` — sender = `whatsappService.js`
- `GET /internal/crm/leads`
- `POST /internal/crm/leads/:leadId/mode` — `AUTO|HUMAN|PAUSED`
- `POST /internal/crm/leads/:leadId/messages` — отправка через существующий `sendWhatsAppMessage`

Управление менеджера из WhatsApp (`handleManagerMessage`, `managementControl`) не отключено и не переписано.

Смена номера/инстанса WhatsApp не меняет UUID компании и клиентов в CRM. Меняется mapping `ExternalIdentity`.

`@lid` без номера не превращается в телефон. Это IncompleteIntake.

## Ограничения провайдера

- Сейчас в боте обычный Green API, не Cloud API/WABA.
- Тариф Developer ограничивает число чатов.
- Webhook бота по-прежнему без подписи (ограничение текущего кода; не выдумывали HMAC).
- Живая отправка клиентам из CRM/seed/тестов не выполняется.
