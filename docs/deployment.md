# Развёртывание

## Состав

- `apps/api` — REST
- `apps/worker` — outbox и расписание из PostgreSQL
- `apps/web` — кабинет
- PostgreSQL 16
- Redis (опционально; без него worker polling жив)
- Локальные файлы или S3

`docker-compose.yml` описывает postgres, redis, api, worker. На машине разработки Docker не установлен — compose не прогонялся.

## Переменные

См. `.env.example`. Бизнес-настройки компаний — в БД. Нет `OWNER_PHONE` для маршрутизации CRM.

## Миграции

```bash
npm run db:generate
# продовый Postgres:
DATABASE_URL=postgresql://... npm run db:push
npm run db:seed
```

Seed не шлёт внешние сообщения.

## Переключение старого бота

1. CRM работает и принимает формы без WhatsApp.
2. Бот продолжает держать Green API webhook и sender.
3. Включить мост секретом, проверить health.
4. Кабинет зеркалирует режимы; менеджер по-прежнему управляет из WhatsApp.
5. Перенос webhook на CRM — только после отключения автоответа бота. Откат: вернуть webhook на `whatsap ai/server.js`.

## Health

- `GET /health` — процесс жив
- `GET /ready` — БД отвечает

## Word на Render

Ошибка `word_conversion_unavailable` означает, что API не смог запустить `soffice` (LibreOffice). Наличие Dockerfile не помогает сервису с runtime Node: Render не использует его при такой настройке.

В `render.yaml` выбран runtime Docker с контекстом корня репозитория и `apps/api/Dockerfile`. Образ устанавливает LibreOffice, собирает кабинет и выполняет `scripts/check-word-runtime.mjs`: оба тестовых договора DOCX/DOC должны преобразоваться в PDF, иначе сборка завершится ошибкой. API использует `API_PORT`, затем выданный Render `PORT`, затем 4100.

Для уже работающего сервиса:

1. Опубликовать изменения репозитория.
2. Если сервис управляется Blueprint — синхронизировать его. Если настройки заданы вручную — в том же сервисе открыть Settings → Build → Source → Edit, сохранить текущие репозиторий и ветку, выбрать Docker, путь `./apps/api/Dockerfile`, контекст `.`. Удалить старое переопределение команды запуска, чтобы применялся CMD образа.
3. Сохранить существующие переменные окружения, подключение БД, домен и постоянный диск `/var/data`. Не создавать заменяющий сервис и не запускать seed для исправления конвертации. Если задан `CRM_SOFFICE_PATH`, он должен указывать на `/usr/bin/soffice` в образе, либо его нужно убрать.
4. Запустить Deploy, убедиться в строках `Word runtime: DOCX → PDF OK` и `Word runtime: DOC → PDF OK`, проверить `/health` и `/ready`, затем импортировать договор через кабинет и проверить оригинал и PDF-копию.

Смена runtime существующего сервиса описана в [документации Render](https://render.com/docs/native-runtimes#changing-a-services-runtime). Локальная успешная проверка не подтверждает установку LibreOffice на действующем сервере.

## Backup

Цель ТЗ: RPO 24 ч, RTO 4 ч. Автобэкап не запускался в этой среде. Для Postgres: `pg_dump` ежедневно. PGlite: копия каталога `data/pglite`. После restore не включать массовую переотправку outbox.

## Откат

Откатить API/worker на предыдущий образ, не запускать второй WhatsApp-продавец.
