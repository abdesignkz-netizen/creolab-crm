# BasQar: подготовка iOS и Android — результат

Дата: 03.11.2026. Ветка: `codex/mobile-store-release`. Исходная версия: `90869bc5bf663edcf00f03593d1fa71c8ae8327b`.

**Подготовлены исходники, конфигурации и нативные проекты. Облачная проверка завершена: получены тестовые Android APK/AAB и iOS-приложение для симулятора. IPA для физического iPhone не собрана, устройства не проверены. Production и магазины не изменялись.** Подробности, ссылки на файлы и ограничения — в [отчёте облачной сборки](BasQar-mobile-cloud-2026-11-03.md).

## 1. Что уже было реализовано

В `apps/mobile` существовал модуль Expo SDK 53 / React Native 0.79 с упрощёнными экранами входа, обзора, заявок, сделок и задач. Веб-кабинет уже имел мобильную адаптацию и значительно более полный набор функций. Общие API, аккаунты и таблица устройств `DeviceInstallation` существовали. Готовых native-проектов, профилей EAS для выпуска, рабочих release-иконок и завершённой доставки мобильных push не было.

## 2. Какой способ выбран

Сохранён существующий Expo-модуль; переход на Capacitor или другую новую архитектуру не выполнялся. Обновление до Expo 54 / RN 0.81.5 даёт основу для Android API 36 и современного iOS toolchain. Адаптивный кабинет открывается внутри WebView, а нативный слой обслуживает навигацию, файлы, OAuth, уведомления и разрешения. CRM не реализована заново. Старые неполные мобильные экраны заменены входом в полный существующий кабинет.

## 3. Какие изменения внесены

- Название BasQar, идентификаторы `kz.bsqr.app`, иконки, splash, описание разрешений и профили APK/AAB/iOS.
- Production HTTPS, проверка совместимости API, системный Back, безопасные внешние ссылки, состояния отсутствия сети и восстановления страницы.
- Постоянная web-сессия с существующими серверными правилами. Пароль и сессионные токены не передаются через bridge.
- Сохранение документов, CSV/Excel и клиентских выгрузок через системное меню; лимит передачи 20 МБ, проверка порядка частей и очистка временных файлов. На Android файл не удаляется сразу после выбора приложения: экспорт старше 24 часов очищается при возвращении или следующем запуске BasQar. PDF статистики создаётся нативно из готового отчёта, без неподдерживаемого окна печати; содержимое отчёта ограничено 512 К символов. Уже готовые документы передаются без перегенерации.
- Возврат из Google/Instagram через системный браузер с проверкой state/provider и исходной серверной сессии.
- Регистрация и отзыв push-устройства, очередь/тихие часы/receipts, защита после смены аккаунта. Используются существующие таблицы и worker.
- Публичная страница и запрос удаления аккаунта в существующую поддержку; автоматическое удаление компании не выполняется.
- В native-кабинете цифровая подписка BasQar не продаётся через внешний эквайринг; доступ компании показывается без checkout. Веб-оплата сохранена.
- NCALayer на телефоне выдаёт понятное требование продолжить на компьютере. Документы и черновики остаются в общем кабинете.
- Отдельный CI для проверки и тестовых native-артефактов: вручную или при изменении кода в проверочной ветке, без отправки в магазины. Секреты/данные компаний исключены из EAS-архива.

Новых серверов, баз данных, миграций схемы или изменений production нет. Веб-регрессия и размер начальной загрузки проверены. Ошибочная зависимость PostCSS внутри мобильного сборщика приведена к уже заданной безопасной версии проекта; остальные существовавшие предупреждения отдельно отмечены ниже.

## 4. Изменённые файлы

Основные группы: `apps/mobile` (оболочка, политика ссылок/файлов, bridge, assets, Expo/EAS/signing), `mobileAppService` и `nativePushService` (API/уведомления), минимальные изменения App/Paywall/Settings/NCALayer в web, тесты и инструкции. Полный список в конце отчёта и в JSON рядом.

## 5. Android

Проект `apps/mobile/android` успешно сгенерирован. Проверены applicationId, API 36, запрет cleartext и backup, разрешения, отсутствие debug-подписи в release. Профили APK и AAB подготовлены.

**Тестовые APK и AAB успешно собраны в GitHub Actions.** Проверки подписи APK и zip alignment 16 KB прошли. Использован временный тестовый ключ; подпись для магазина и Google Play app record ещё нужны. Полная проверка ELF-библиотек и запуска на устройстве не выполнена. На локальном Mac по-прежнему отсутствуют Java Runtime и Android SDK, но это не помешало облачной сборке.

## 6. iOS

Проект `apps/mobile/ios/BasQar.xcodeproj` сгенерирован; Info.plist, entitlements и project.pbxproj проходят plutil. Подготовлены Bundle ID, иконка, splash, permissions и profile для сборки. Агрегация privacy manifests включена.

**Release-приложение .app для симулятора успешно собрано в GitHub Actions с Xcode 26+. IPA для физического iPhone не получена.** Apple Team, сертификат и provisioning необходимы для сборки на устройство и публикации. На локальном Mac установлен только CommandLineTools, полного Xcode и CocoaPods нет; облачный runner установил Pods и успешно собрал `.xcworkspace`.

## 7. Фактически пройденные проверки

| Проверка | Результат |
| --- | --- |
| Чистая установка по lock-файлу | Успех |
| Типы API, mobile, web, worker, contracts | Успех |
| 10 серверных наборов на изолированной PGlite | 91 тест, 0 ошибок |
| Web | 143 теста, 0 ошибок |
| Mobile: links, OAuth, transfer/PDF, bridge/session, config | 7 тестов, 0 ошибок |
| Production web build | Успех; начальный JS ~1098,8 кБ, лимит 1100 кБ сохранён |
| Hermes export iOS / Android | Обе платформы собраны; это JS-пакеты, не IPA/APK |
| Expo prebuild | Оба проекта сгенерированы |
| Expo Doctor | 17/18; не пройдена проверка отсутствующего CocoaPods |
| Release config и plutil | Успех |
| Git diff whitespace / YAML workflow | Успех |
| Реальные Google/Instagram, APNs/FCM, телефон | Не проверены; тесты использовали замену внешнего транспорта |
| Linux/native CI | Успех: общие проверки, Android APK/AAB, iOS Release Simulator |
| Дополнительные workspaceAcceptance + HTTP | 20 тестов, 0 ошибок; изолированная PGlite, без внешних отправок |
| Обработка ошибок облачной сборки | 4 теста, 0 ошибок |

`npm audit`: 39 предупреждений — 1 low, 33 moderate, 5 high, 0 critical. High: body-parser, image-size, node-forge, vite, zod. Перечисленные high затрагивают те же версии, которые уже присутствовали в исходной ветке; массовое обновление вне мобильной задачи не выполнялось. Перед публичным выпуском нужен отдельный разбор применимости и исправлений. Нельзя считать проверку безопасности полностью закрытой.

## 8. Что нужно для App Store

Apple Developer организации и App Store Connect, подтверждённый Bundle ID/Team ID, Xcode 26+ и iOS 26 SDK+, реальная подпись, APNs, TestFlight/device-приёмка, privacy-декларации и проверка собранного Privacy Report. Нужны реальные скриншоты, демоаккаунт и инструкции модератору. Требование Xcode/SDK подтверждено [Apple](https://developer.apple.com/news/upcoming-requirements/?id=02212025a).

Модель приложения-компаньона и самостоятельная полезность должны пройти проверку по правилам 3.1.3 и 4.2; упаковка сайта сама по себе принятия не гарантирует. [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

## 9. Что нужно для Google Play

Play Console владельца, Play App Signing/upload key, настоящий подписанный AAB, Firebase/FCM, device-приёмка и проверка 16 KB. Target API 36 уже задан в конфигурации, но подтверждать соответствие нужно по итоговому артефакту. [Google Play target API](https://support.google.com/googleplay/android-developer/answer/11926878), [Android 16 KB](https://developer.android.com/guide/practices/page-sizes).

Также нужны Data Safety, privacy/deletion URLs, рейтинг, реальные скриншоты/feature graphic, доступ модератора и обязательное тестирование, если его требует конкретный аккаунт Play Console.

## 10. Что остаётся до фактической публикации

1. Восстановить доступный backend и развернуть проверенный совместимый API/web этой ветки обычным процессом выпуска BasQar. Render отвечает `Service Suspended`; по указанию владельца проверка продолжена без рабочего сервера. Развёртывание не выполнялось.
2. Связать аккаунты владельца с процессом выпуска и задать настоящие credentials. Облачная сборка уже работает; для EAS и push дополнительно нужен реальный Expo project ID. Секреты передаются через защищённые хранилища, не в чат и не в Git.
3. Получить AAB с постоянной подписью и подписанный iOS archive/IPA; проверить физические устройства по матрице `docs/mobile-store-checklist.md`. Тестовые Android APK/AAB и iOS Simulator .app уже доступны.
4. Настроить и проверить APNs/FCM, затем включить `MOBILE_PUSH_ENABLED`. Verified Links включать только после публикации настоящих AASA/assetlinks; сейчас выключены.
5. Утвердить и реализовать исполнение запросов удаления с понятным сроком и подтверждением завершения; один support ticket не является доказательством удаления.
6. Завершить разбор предупреждений зависимостей и store-декларации, подготовить реальные демонстрационные материалы.
7. Получить отдельное разрешение владельца на отправку в магазины. Отправка и публикация не производились.

Сохраняющиеся ограничения: интернет обязателен; мобильная ЭЦП NCALayer отсутствует; native-сохранение файлов до 20 МБ; покупка подписки BasQar остаётся в web; фактическая доставка push не проверена. Это явно отражено в инструкции и не скрывается под статусом «всё готово».

Подробные команды: `docs/mobile-release.md`. Матрица, store-тексты и инвентаризация данных: `docs/mobile-store-checklist.md`.

## Полный список файлов этой работы

- `.easignore`
- `.env.example`
- `.github/workflows/mobile-acceptance.yml`
- `.gitignore`
- `apps/api/src/app.ts`
- `apps/api/src/esfNcaLayerClient.test.ts`
- `apps/api/src/mobileApp.test.ts`
- `apps/api/src/services/backgroundJobs.ts`
- `apps/api/src/services/domainService.ts`
- `apps/api/src/services/googleConnectionService.ts`
- `apps/api/src/services/instagramOAuthService.ts`
- `apps/api/src/services/mobileAppService.ts`
- `apps/api/src/services/nativePushService.ts`
- `apps/api/src/services/notificationService.ts`
- `apps/mobile/.env.example`
- `apps/mobile/app.config.js`
- `apps/mobile/app.json`
- `apps/mobile/app/_layout.tsx`
- `apps/mobile/app/deals.tsx`
- `apps/mobile/app/inbox.tsx`
- `apps/mobile/app/index.tsx`
- `apps/mobile/app/more.tsx`
- `apps/mobile/app/tasks.tsx`
- `apps/mobile/app/today.tsx`
- `apps/mobile/assets/README.md`
- `apps/mobile/assets/adaptive-icon.png`
- `apps/mobile/assets/icon.png`
- `apps/mobile/assets/notification-icon.png`
- `apps/mobile/assets/play-store-icon.png`
- `apps/mobile/assets/splash.png`
- `apps/mobile/eas.json`
- `apps/mobile/index.js`
- `apps/mobile/link-paths.json`
- `apps/mobile/package.json`
- `apps/mobile/plugins/with-release-signing.js`
- `apps/mobile/scripts/check-release.mjs`
- `apps/mobile/scripts/config.test.cjs`
- `apps/mobile/scripts/generate-assets.mjs`
- `apps/mobile/scripts/generate-link-associations.mjs`
- `apps/mobile/src/BasQarApp.tsx`
- `apps/mobile/src/lib/api.ts`
- `apps/mobile/src/policy.test.ts`
- `apps/mobile/src/policy.ts`
- `apps/mobile/src/webBridge.ts`
- `apps/mobile/tsconfig.json`
- `apps/web/package.json`
- `apps/web/src/App.tsx`
- `apps/web/src/components/BillingCheckoutUi.tsx`
- `apps/web/src/components/ContractSignatureSummary.tsx`
- `apps/web/src/components/PaywallContent.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/download.ts`
- `apps/web/src/lib/nativeApp.ts`
- `apps/web/src/lib/signing/esfNcaLayerClient.ts`
- `apps/web/src/lib/signing/ncalayerClient.ts`
- `apps/web/src/lib/statsExport.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/pages/AccountDeletionPage.tsx`
- `apps/web/src/pages/ClientsPage.tsx`
- `apps/web/src/pages/NativeAccountPage.tsx`
- `apps/web/src/pages/SettingsPage.tsx`
- `docs/mobile-release.md`
- `docs/mobile-store-checklist.md`
- `docs/mobile-test-installation.md`
- `docs/notifications.md`
- `output/documents/BasQar-mobile-cloud-2026-11-03.md`
- `output/documents/BasQar-mobile-cloud-2026-11-03-checks.json`
- `package-lock.json`
- `scripts/ci-error-annotation.mjs`
- `scripts/ci-error-annotation.test.mjs`
- `scripts/native-app.test.mjs`
- `scripts/sales-forecast.test.mjs`
- `scripts/system-locale.test.mjs`
- `scripts/test-api.mjs`
