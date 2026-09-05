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

## Backup

Цель ТЗ: RPO 24 ч, RTO 4 ч. Автобэкап не запускался в этой среде. Для Postgres: `pg_dump` ежедневно. PGlite: копия каталога `data/pglite`. После restore не включать массовую переотправку outbox.

## Откат

Откатить API/worker на предыдущий образ, не запускать второй WhatsApp-продавец.
