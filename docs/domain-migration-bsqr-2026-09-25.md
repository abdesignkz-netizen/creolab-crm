# Перенос CRM на bsqr.kz — аудит и порядок переключения

Дата: 25.09.2026. Новый пользовательский адрес: `https://bsqr.kz`.
Статус: аудит завершён до изменений кода; подключение production-домена ещё не выполнено.

## 1. Где использовался старый домен

Проверены исходники, скрытые конфигурации, локальные ENV без вывода секретов, Docker,
Render Blueprint, маршруты, генераторы ссылок и текущий production через read-only API.
CRM — один Docker Web Service Render `creolab-crm`: Express отдаёт API и сборку Vite.
DNS `crm.creolab.kz` указывает на `creolab-crm.onrender.com`.

| Группа | Место | Назначение / решение |
|---|---|---|
| A | `apps/mobile/app.json` | Universal/App Links: добавить bsqr.kz, старый оставить на переходный период |
| A | `docs/mobile-release.md` | Обновить целевой адрес и условия проверки native links |
| A | `APP_BASE_URL`, `services/invitationService.ts` | Основной адрес и приглашения |
| A | `services/contractSigningService.ts`, `avrSigningService.ts`, `contractSignedExport.ts` | Публичные ссылки подписи и QR проверки документов |
| A | `app.ts`: `documents/from-command`, `contracts/:id/send-for-sign` | Устранить подстановку Origin браузера вместо основного адреса |
| A | `services/documentCommandService.ts` | Устранить fallback на localhost при генерации ссылки |
| A | `app.ts`: возврат из Google OAuth | Возвращает пользователя на APP_BASE_URL/integrations |
| A | `ALLOWED_ORIGINS`, `config.ts`, CORS middleware | Разрешить новый origin, временно сохранить старый; без wildcard |
| A/C | `googleConnectionService.ts`: Google callback | Изначально API_BASE_URL; аудит выявил зависимость от host-only cookie: браузерный callback переносится вместе с APP_BASE_URL, после регистрации URI у Google |
| B | `metaConnectionService.ts`, `tiktokConnectionService.ts`, `telegramCompanyService.ts` | Webhook URLs внешних систем; сверять фактические настройки каждого подключения |
| B | `integrationCatalogService.ts`, `platformIntegrationService.ts` | Формы `/public/forms/.../submissions`, универсальные `/api/v1/integrations/.../events` |
| B | `aiManagerRegistration.ts`, `sellerLink.ts` | Seller-events callback AI Manager; integrationId и секреты сохраняются |
| B | AI Control `/api/integrations/ai-control/*`, `/api/v1/integrations/...` | Старые server-to-server клиенты должны продолжить работать |
| B | AI_MANAGER_URL, WHATSAPP_SELLER_URL, Green API, ESF URLs | Независимые сервисы; не переносятся вместе с интерфейсом |
| B | `docs/render-contract-signing.md`, предыдущие отчёты WhatsApp/АВР | Исторические факты проверок старого адреса, не переписывать |
| C | PS.kz DNS, Render custom domains/ENV/TLS | Вне репозитория, требуют доступа к кабинетам |
| C | Google/Meta/TikTok/Telegram, AI Manager, отправители форм/вебхуков | Обновление callback/webhook у каждого провайдера перед полным 301 |

`app.ts` также содержал комментарий с примером старого same-origin адреса.
Других прямых runtime-хардкодов crm.creolab.kz не найдено. `APP_URL`, `PUBLIC_URL`,
`NEXTAUTH_URL`, `COOKIE_DOMAIN`, `SESSION_DOMAIN`, `CSRF_TRUSTED_ORIGINS` проект не использует.
Локальные `.env` остаются локальными. В `render.yaml` доменные ENV раньше не были заданы:
они управляются через Render Dashboard. Конфигураций nginx, Netlify, Vercel в проекте нет.

## 2. Изменения кода

- Ссылки подписи в двух HTTP-маршрутах используют APP_BASE_URL, а не Origin браузера.
- Внутренняя команда формирования ссылки использует APP_BASE_URL вместо localhost.
- Google OAuth callback использует APP_BASE_URL: браузер возвращается туда, где есть его cookie.
  URI сохраняется в одноразовом state на момент начала авторизации и используется при обмене кода.
  Для старых state без сохранённого URI на переходном этапе остаётся fallback к API_BASE_URL.
  Проверки сессии, одноразового state, пользователя и tenant сохранены.
- Добавлен опциональный редирект `lib/legacyDomainRedirect.ts`, выключенный по умолчанию.
  Он сопоставляет точный Host, не доверяет Origin/X-Forwarded-Host, не затрагивает lead.bsqr.kz.
- Новый домен добавлен в мобильные deep links; старый сохранён для совместимости.
- `.env.example`, `render.yaml` и `deploy/bsqr-domain.env.example` описывают переключение;
  секреты и действующие production ENV не менялись.

## 3. Что сохраняется и почему

- Web frontend использует относительный API URL и `credentials: include`; backend остаётся тем же сервисом и базой.
- Login/logout, страницы после входа, onboarding и навигация используют относительные пути.
- Cookie `crm_session` — host-only, `HttpOnly`, `SameSite=Lax`, `Secure` в production, Path=/.
  На новом домене нужен повторный вход. Токены между доменами через URL не передаются.
- Tenant определяется сессией и проверенными memberships, а не hostname.
- Отдельного CSRF middleware/trusted-origin списка в текущем проекте нет. Сохраняются SameSite cookies,
  JSON API и ограниченный CORS; CORS сам по себе не является полной CSRF-защитой.
- Восстановление пароля и подтверждение email используют одноразовые коды, не абсолютные ссылки.
  Письма Resend не требуют смены домена отправителя. MAIL_FROM, SPF/DKIM/MX не менять автоматически.
- Manifest start_url и assets относительные; canonical/og:url/sitemap с production-хостом отсутствуют.
- WebSocket относится к локальному NCALayer (`wss://127.0.0.1:13579`), его менять нельзя.
- Push subscriptions привязаны к origin: на новом домене потребуется повторное разрешение уведомлений.
- Подписанные PDF/CMS и хеши не изменяются: старые QR/ссылки должны работать через редирект.
- Маркетинговый `lead.bsqr.kz`, почта и остальные поддомены не меняются.

## 4. Production ENV

Применять **в существующем сервисе Render → Environment**, после готовности нового DNS/TLS.
Файл `deploy/bsqr-domain.env.example` — только дополнение к текущему окружению, не его замена.
Dashboard недоступен для чтения: старый API URL и разрешение CORS подтверждены поведением API;
точное значение APP_BASE_URL и полный список ALLOWED_ORIGINS сверить в Dashboard.

```text
APP_BASE_URL=
https://crm.creolab.kz (ожидаемое старое значение; сверить)
→
https://bsqr.kz

API_BASE_URL=
https://crm.creolab.kz
→
https://crm.creolab.kz (переходный этап; пока не менять)

ALLOWED_ORIGINS=
текущий список, содержащий https://crm.creolab.kz
→
https://bsqr.kz,https://crm.creolab.kz
(сохранить другие действительно нужные доверенные origins, если они есть)

LEGACY_APP_ORIGIN=
не задан
→
https://crm.creolab.kz

LEGACY_REDIRECT_MODE=
не задан / off
→
ui
```

Google Cloud при настроенном OAuth: сначала добавить
`https://bsqr.kz/api/v1/integrations/google/callback`, затем менять APP_BASE_URL.
Текущий API_BASE_URL не меняется, потому что технические отправители ещё используют старый адрес.
Когда все они переведены, применить второй этап:

```text
API_BASE_URL=
https://crm.creolab.kz
→
https://bsqr.kz

ALLOWED_ORIGINS=
https://bsqr.kz,https://crm.creolab.kz
→
https://bsqr.kz

LEGACY_REDIRECT_MODE=
ui
→
all
```

Другие доверенные origins сохранять только если используются. Новые COOKIE_DOMAIN или
CSRF_TRUSTED_ORIGINS не добавлять: приложение не читает эти переменные.

## 5. DNS в PS.kz

При аудите bsqr.kz и lead.bsqr.kz возвращали **SERVFAIL** (ошибка делегирования),
а не просто отсутствие A-записи. Сначала проверить активность домена, делегирование,
наличие зоны и согласованность DNSSEC/DS. Не отключать DNSSEC вслепую.
Повторная проверка: `ns1.ps.kz` отвечает **REFUSED** для bsqr.kz; публичный resolver также
сообщает REFUSED от авторитетного сервера 195.210.46.172. Это указывает на проблему обслуживания
зоны; проверить/создать зону bsqr.kz в PS.kz либо передать эту диагностику их поддержке.

В PS.kz: «Домены → Управление DNS → bsqr.kz → Изменить».
Для зоны в PS.kz нужны ns1.ps.kz, ns2.ps.kz, ns3.ps.kz; при смене NS предварительно
перенести всю существующую зону, чтобы сохранить почту и маркетинговые поддомены.

Для корня `@`: **A → 216.24.57.1**, TTL 300 на период переключения, если интерфейс позволяет.
Альтернатива — ALIAS/ANAME → `creolab-crm.onrender.com`, только если PS.kz поддерживает этот тип.
Использовать один вариант. Не копировать текущие IP .16/.18 из ответа DNS старого домена.
Убрать конфликтующие A/AAAA только у корня CRM; не трогать MX/TXT/lead/прочие поддомены.
Не создавать wildcard `*.bsqr.kz` и не включать парковку/редирект для всего домена.

Источники: [PS.kz DNS](https://docs.ps.kz/ru/domains/dns-management/manage-dns-records),
[Render DNS](https://render.com/docs/configure-other-dns).

## 6–8. Render, custom domain и SSL

В существующем `creolab-crm`: Settings → Custom Domains → Add Custom Domain → `bsqr.kz`.
Не создавать новую CRM/БД. Старый custom domain сохранить. После DNS нажать Verify;
дождаться подтверждения домена и готового TLS-сертификата, открыть https://bsqr.kz.
Render выдаёт и обновляет сертификат автоматически; при ограничивающих CAA разрешить
letsencrypt.org и pki.goog. Проверить автоматически добавляемый www-алиас, не затрагивая lead.
После этого применять доменные ENV с перезапуском. База, диск, SESSION_SECRET,
JWT-секреты и ENCRYPTION_KEY остаются прежними.

Источник: [Render custom domains](https://render.com/docs/custom-domains).

## 9. Сторонние подключения

В production аудит подтвердил работающие формы и универсальный webhook на старом домене,
WhatsApp настроен; Google OAuth на момент проверки не настроен. В журнале есть обработанные
события. Нельзя направить все старые POST на 301: клиент может заменить POST на GET.

Перед полным редиректом зарегистрировать новые адреса у активных отправителей:

| Система | Новый адрес при окончательном переносе технических URL |
|---|---|
| Google Cloud OAuth Web Client | `https://bsqr.kz/api/v1/integrations/google/callback` |
| Meta | `https://bsqr.kz/public/integrations/meta/<integrationId>` |
| TikTok | `https://bsqr.kz/public/integrations/tiktok/<integrationId>/<deliveryKey>` |
| Telegram | `https://bsqr.kz/public/integrations/telegram/<integrationId>` |
| Формы сайта | `https://bsqr.kz/public/forms/<publicKey>/submissions` |
| Универсальный webhook | `https://bsqr.kz/api/v1/integrations/<integrationId>/events` |
| AI Manager seller-events | `https://bsqr.kz/api/v1/integrations/seller-events/<integrationId>` |
| AI Control | Новый host bsqr.kz, существующие пути `/api/integrations/ai-control/*` или `/api/v1/...` |

Использовать фактические ID/ключи из настроек, не создавать новые Integration и не менять секреты.
Сохранённые callbackUrl обновлять через штатные настройки/регистрацию интеграций, не массовым SQL
по зашифрованным Credential. На стороне AI Manager отдельно проверить CRM_EVENTS_URL и адреса
AI Control; исходящий AI_MANAGER_URL/Green API host остаётся прежним.
Google callback отличается от server-to-server вебхуков: его переносить вместе с интерфейсом,
иначе host-only cookie нового домена не попадёт на старый callback. Сначала добавить новый Google
redirect URI, старый убрать только после завершения активных OAuth flow (state действует 10 минут).
Переключение callback не требует смены токенов или повторного создания компании.
Не отправлять сообщения клиентам для проверки: использовать технические статусы, журнал и тестовую среду.

## 10. Старый домен / 301

Render Dashboard Redirects/Rewrites относится к Static Sites, а CRM — Docker Web Service.
PS.kz предлагает редирект домена, но его документация не подтверждает сохранение path/query
и исключения вебхуков; такой переключатель нельзя применять ко всему creolab.kz (затронет другие услуги).
Поэтому предусмотрен выключенный до готовности нового домена редирект в существующем приложении.
Точная настройка после DNS/TLS: `LEGACY_APP_ORIGIN=https://crm.creolab.kz`,
`APP_BASE_URL=https://bsqr.kz`, `LEGACY_REDIRECT_MODE=ui`.

- `off` — редирект выключен (по умолчанию, безопасно для предварительной публикации кода).
- `ui` — 301 для GET/HEAD пользовательских страниц старого host; `/api`, `/public`,
  `/.well-known` и остальные методы продолжают обслуживаться на том же backend.
- `all` — 301 для всех путей и методов старого host, кроме `/health` и `/ready` для мониторинга.
  Включать только после переноса всех API-клиентов, webhooks, старых мобильных сборок и завершения OAuth flow.
- Путь и query сохраняются дословно, включая percent encoding. Редирект не затрагивает новый домен,
  lead.bsqr.kz, creolab.kz или `*.bsqr.kz`; wildcard отсутствует.

Контроль после включения:

```bash
curl -I 'https://crm.creolab.kz/login'
# 301, Location: https://bsqr.kz/login
curl -I 'https://crm.creolab.kz/settings/profile?tab=security'
# 301, Location: https://bsqr.kz/settings/profile?tab=security
curl -I 'https://bsqr.kz/deals'
# 200, без цикла редиректа
curl -I 'https://crm.creolab.kz/public/sign/nonexistent'
# На этапе ui — НЕ 301; это намеренно несуществующий токен, 404 допустим.
```

Для отката сервера: `LEGACY_REDIRECT_MODE=off`, вернуть предыдущий APP_BASE_URL и CORS;
API_BASE_URL на этапе ui не менялся. 301 может кешироваться браузерами: выключение сервера
не удаляет уже сохранённый редирект у клиентов, поэтому новый домен/TLS при откате сохранять.
Не удалять старый custom domain и его сертификат: старые ссылки в подписанных PDF остаются значимыми.

Источники: [Render redirects](https://render.com/docs/redirects-rewrites),
[PS.kz redirect](https://docs.ps.kz/ru/account/faq/general-console-services/what-is-redirect).

## 11. Проверки

До изменений: старый сайт HTTP 200, BasQarCRM; вход owner и выход проверены;
cookie без Domain, Secure/HttpOnly/SameSite=Lax; CORS разрешает старый origin,
новый пока не разрешён, посторонний origin не получает разрешения.
Настройки подключений проверены чтением, сообщения клиентам не отправлялись.
Локально пройдены целевые проверки: пути/query редиректа, отключённый/переходный/полный режим,
исключение маркетинга, сохранение POST payload и callbacks, запрет зацикливания/небезопасного target,
ссылки договора и приглашений на bsqr.kz, CORS нового/старого/постороннего origins, cookie без Domain,
повторное чтение сессии. Google проверяет новый callback, новый адрес возврата и исходный redirect_uri
при изменении конфигурации во время авторизации. Google/криптопровайдеры в тестах заменены тестовыми.
Build и typecheck прошли. Команда lint прошла, но в workspaces нет настроенных lint-скриптов:
это не результат полноценного статического линтера.

Итог команд:

| Команда | Результат |
|---|---|
| `npm run build --workspaces --if-present` | Успешно, Vite production build |
| `npm run typecheck` | Успешно: API, mobile, web, contracts |
| `npm run lint` | Exit 0; lint-скрипты в workspaces отсутствуют |
| `RESEND_API_KEY='' npm test` | Exit 0; 108/108 изолированных test files, затем workspace contracts; 784 успешных исполнения тестов, без пропусков/ошибок |
| `node --test scripts/start-api-with-kalkan.test.mjs` | Успешно |
| `git diff --check` | Без ошибок |

Общий набор покрывает регистрацию, коды email/reset, компании/tenant isolation, приглашения,
сессии и logout, документы и две ЭЦП, AI Control, AI Manager, формы и сторонние подключения.
Это локальные интеграционные тесты с изолированными БД, не реальные сообщения/подписи production.

После внешнего переключения обязательно проверить именно в браузере:
вход → обновление страницы → `/deals` → выход; восстановление пароля и регистрацию с тестовой почтой;
подтверждение email/создание компании; приглашение и смену компании; CORS и cookie Secure/HttpOnly/Lax;
открытие тестового договора/АВР без аккаунта, ссылки проверки/скачивания; NCALayer на устройстве;
WhatsApp/AI Manager и журнал технических событий без отправки сообщений клиентам;
старые ссылки с параметрами и независимый lead.bsqr.kz. Пока DNS не работает, эти production-сценарии
на новом домене не могут считаться проверенными.

## 12. Оставшиеся ограничения

Нет доступного управления кабинетами PS.kz и Render. Само указание провайдеров не даёт доступа.
DNS/TLS, ENV, callbacks и реальная проверка браузера на новом origin ещё не выполнены.
Миграция считается законченной только после этих шагов и проверки старых URL с path/query.
Universal/App Links требуют новой мобильной сборки и настоящих AASA/assetlinks с идентификаторами
подписанных приложений — их нет в репозитории; одних Expo intentFilters недостаточно.
