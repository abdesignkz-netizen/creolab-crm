# Отчёт приёмки A01–A50

Дата: 6 сентября 2026  
Среда: локальный Node 24.18.0, PGlite (не Docker Postgres), без живого Green API.

| ID | Статус | Доказательство / ограничение |
| --- | --- | --- |
| A01 | passed | `apps/api/src/http.test.ts` — вход `owner@creolab.example` без телефона |
| A02 | passed | Публичная форма с `+77010000011` создаёт Inquiry; WhatsApp не вызывался |
| A03 | passed | Пустой телефон формы → 422 + field_errors.phone |
| A04 | not-run | Второй сайт добавляется записью Integration/Form в кабинете; UI создания второй формы есть частично (seed + API), мастер «Добавить» не доведён до отдельного экрана мастера |
| A05 | passed | Повтор `x-submission-id` возвращает тот же receipt |
| A06 | not-run | Разные event_id с одним текстом должны давать две заявки; логика есть, отдельный автотест не писался |
| A07 | passed | Один номер в CREOLAB и Demo Agency — разные inquiry id |
| A08 | not-run | Нужен живой инстанс Green API |
| A09 | passed | Webhook без телефона → `disposition=needs_phone`, нет `inquiry_id` |
| A10 | passed | `tenant_id`/`role`/`assignee_id` в теле не назначают права |
| A11 | not-run | Чужой UUID в API должен дать 404 той же компании; проверка membership есть, кросс-tenant media/export/WS не гонялись |
| A12–A23 | not-run | Живой WhatsApp webhook. Защита повторов остаётся в боте. CRM не второй sender |
| A16 | not-run | Take в CRM ставит mode=human и отменяет queued outbound; гонка с живым AI не прогонялась |
| A24–A29 | not-run | Текущий продавец в боте; sandbox CRM не пишет в WhatsApp |
| A30 | passed частично | Неверная подпись webhook → 401; oversized/spam — лимит 200kb и rate limit формы |
| A31 | not-run | Нет искусственного падения PGlite в тесте |
| A32 | not-run | Worker читает outbox из БД; Redis не использовался |
| A33–A37 | not-run | Follow-up выключен; эскалации в ScheduledAction |
| A38–A43 | not-run | Нет APNs/FCM/VAPID/Telegram employee bot |
| A44 | not-run | Нет полевого теста сети телефона |
| A45 | not-run | Backup restore не выполнялся |
| A46 | not-run | Экспорт job ещё не полный |
| A47 | not-run | Загрузка файлов формы в MVP текстовая |
| A48 | not-run | Статистика считает нули честно; отдельный день с платежами не гонялся |
| A49 | not-run | Одновременные web+mobile не проверялись на устройстве |
| A50 | passed | Inquiry.id UUID ≠ phoneNormalized; роль не по номеру |

Автотесты: 13 passed (`@creolab/contracts` + `@creolab/api`).  
Тесты бота: запускаются отдельно в `whatsap ai` (менеджерский контур не переписывался).
