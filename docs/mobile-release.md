# BasQar: мобильный выпуск

Статус на 03.11.2026: исходный код и генерация проектов подготовлены в ветке `codex/mobile-store-release`. Установочные APK/AAB/IPA ещё не собраны. Магазины и production не изменялись. Список фактически выполненных проверок — `output/documents/BasQar-mobile-release-2026-11-03.md`.

## Что используется

Модуль `apps/mobile` уже существовал на Expo 53 / React Native 0.79. Он содержал отдельные упрощённые экраны входа, обзора, заявок, сделок и задач. Они не покрывали действующий кабинет; идентификаторы были development, путь иконки не существовал. Нативные проекты и профили выпуска отсутствовали.

Сохранён Expo, обновлён до SDK 54 / React Native 0.81.5. Вместо повторной реализации CRM приложение открывает существующий адаптивный кабинет в `react-native-webview`. Старые неполные мобильные экраны заменены этим единым входом во все действующие разделы. Сервер, права, учётные записи, тарифные возможности и база общие. Capacitor, второй frontend CRM и новая база не добавлены. Схема БД не менялась.

Нативный слой отвечает только за безопасную навигацию, системное сохранение файлов, разрешения, возврат из OAuth, уведомления и сообщения о проблемах соединения. Интерфейс CRM приходит с `https://bsqr.kz`, как в браузере. Офлайн-редактирование не реализовано; требуется интернет.

## Идентификаторы и конфигурация

| Параметр | Значение |
| --- | --- |
| Имя | BasQar |
| iOS Bundle ID / Android applicationId | `kz.bsqr.app` — проверить доступность в аккаунтах перед первой публикацией |
| Версия | `1.0.0`; первоначальные buildNumber/versionCode `1` |
| Схема | `basqar://` |
| Backend / web | `https://bsqr.kz` |
| Android | minSdk 24, compile/target SDK 36 |
| iOS | минимальная версия из Expo/RN 54/0.81 — 15.1; для публикации Xcode 26+ и iOS 26 SDK+ |
| Сборки | EAS `development`, `preview` (APK), `production` (AAB / iOS archive) |

Production-конфигурация отклоняет другой домен, HTTP, пароль в URL и путь вместо origin. Только профиль `development` допускает HTTP на localhost, 127.0.0.1 или Android emulator 10.0.2.2. Публичные параметры перечислены в `apps/mobile/.env.example`. Секреты подписи, Firebase service account и серверный `EXPO_ACCESS_TOKEN` в приложение не включаются.

По текущим требованиям новые приложения Google Play должны target Android 16 / API 36. [Google Play](https://support.google.com/googleplay/android-developer/answer/11926878). Apple требует Xcode 26+ и SDK iOS 26+ с 28.04.2026. [Apple](https://developer.apple.com/news/upcoming-requirements/?id=02212025a). Перед отправкой требования нужно проверить повторно.

## Установка зависимостей и воспроизводимость

Из корня репозитория:

```bash
npm ci
npm run db:generate
npm run typecheck
npm run test --workspace @creolab/mobile
npm run test --workspace @creolab/web
node scripts/test-api.mjs mobileApp securityAuth securityTenant instagramOAuth googleConnections esfNcaLayerClient
npm run build --workspace @creolab/web
npm run export --workspace @creolab/mobile
npm run prebuild --workspace @creolab/mobile
npm run check:release --workspace @creolab/mobile
```

`export` проверяет выпуск JavaScript/Hermes для обеих ОС, но не создаёт APK/IPA. `prebuild` создаёт `apps/mobile/android` и `apps/mobile/ios`, но не компилирует их. Generated-проекты исключены из Git; источники для воспроизводимой генерации — app.config.js, plugins, assets, package-lock.json. На текущем Mac они уже сгенерированы.

`check:release` проверяет конфигурацию и перечисляет недостающие внешние условия. Его успешный результат означает только корректность проверенных параметров, а не завершённую модерацию или подписанную сборку.

## Android: APK и AAB

Нужны JDK 17, Android SDK API 36 / build-tools 36, Android Studio или настроенное окружение командной строки. Gradle wrapper включён в generated-проект; NDK и остальные пакеты он запрашивает при сборке.

Для настоящего выпуска установить секреты в локальном защищённом окружении или CI:

- `BASQAR_ANDROID_KEYSTORE` — абсолютный путь к реальному upload keystore;
- `BASQAR_ANDROID_STORE_PASSWORD`;
- `BASQAR_ANDROID_KEY_ALIAS`;
- `BASQAR_ANDROID_KEY_PASSWORD`.

Без этих значений локальный release остаётся неподписанным. Плагин `with-release-signing.js` удаляет небезопасное стандартное использование debug-ключа для release. Никаких реальных ключей в этой задаче не создавалось.

```bash
cd apps/mobile/android
./gradlew :app:assembleRelease :app:bundleRelease
```

Результаты: `app/build/outputs/apk/release/` и `app/build/outputs/bundle/release/`. Проверить `apksigner verify`, `zipalign -c -P 16 -v 4`, ELF-сегменты библиотек и работу на 16 KB устройстве. Одной проверки zip alignment недостаточно для полной проверки всех native SDK. [Android: 16 KB](https://developer.android.com/guide/practices/page-sizes). RN 0.81 содержит поддержку Android 16 и 16 KB, но итоговый артефакт всё равно требует проверки. [React Native](https://reactnative.dev/blog/2025/08/12/react-native-0.81).

## iOS: Xcode и TestFlight

Нужны полный Xcode 26+, выбранный через xcode-select, CocoaPods, Apple Developer Program и команда для `kz.bsqr.app`.

```bash
cd apps/mobile/ios
pod install
```

Открыть `BasQar.xcworkspace`, выбрать реальную Team, проверить Bundle ID, разрешения, provisioning profile и Push Notifications. Для локального симулятора:

```bash
xcodebuild -workspace BasQar.xcworkspace -scheme BasQar -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/basqar-ios CODE_SIGNING_ALLOWED=NO build
```

Для устройства и App Store выбрать Generic iOS Device → Archive, проверить архив и подписать реальным distribution profile. Отправка в App Store Connect/TestFlight и публикация выполняются только после отдельного разрешения владельца. Симуляторная `.app` не является IPA и не загружается в магазин.

Агрегация PrivacyInfo.xcprivacy зависимостей включена generated Podfile. После установки Pods и Archive проверить итоговый Privacy Report и required-reason APIs, а не считать наличие флага доказательством соответствия.

## Вариант сборки через EAS

Он позволяет получить iOS/Android сборки без установки обоих SDK на этот Mac, но требует аккаунта Expo и подписей владельца.

1. Войти в Expo и связать проект с аккаунтом владельца; задать реальный `BASQAR_EAS_PROJECT_ID` и при необходимости `BASQAR_EXPO_OWNER`.
2. Указать `BASQAR_APPLE_TEAM_ID`, настроить Apple signing и Android upload key через защищённые credentials EAS.
3. Для Android push передать `BASQAR_GOOGLE_SERVICES_FILE` как file environment variable EAS; загрузить FCM v1 service account в credentials, не в Git.
4. До сборки проверить архив командой `eas build:inspect` и исключения `.easignore`: личные `.env`, данные компаний, output, tmp, сертификаты не должны попадать в архив.
5. Выполнить из `apps/mobile`: `eas build --platform android --profile preview`, затем `eas build --platform all --profile production`.

В eas.json нет auto-submit. EAS подставляет настоящую signing-конфигурацию после prebuild; локальная неподписанная конфигурация не заменяет credentials EAS. [Механизм подписи EAS](https://docs.expo.dev/build-reference/android-builds/). Версию EAS CLI перед запуском зафиксировать в журнале выпуска.

Workflow `.github/workflows/mobile-acceptance.yml` запускается вручную или при изменении кода в проверочной ветке `codex/mobile-store-release`. Изменения только документации не запускают повторную сборку. Он собирает APK/AAB с одноразовым тестовым ключом и iOS Release для симулятора, проверяет типы, тесты, web и Hermes. Артефакты CI помечены `CI-ONLY` / `NOT-IPA`; они не являются store-релизами. Состояние последнего облачного прогона фиксируется отдельно в отчёте проверки мобильных сборок. Никаких команд отправки в магазины в нём нет.

## Авторизация, ссылки и файлы

- Используется существующий web login и HttpOnly session cookie в постоянном WebView. Пароль, refresh/access token не передаются через JS bridge и не сохраняются в новом native-хранилище.
- Срок жизни и отзыв сессии остаются серверными. Перезапуск не должен сбрасывать действующую сессию; после её истечения нужен обычный вход. Это нужно подтвердить на физическом телефоне.
- SecureStore содержит только push token и согласие на push. Выход отзывает привязку устройства. При смене пользователя токен перепривязывается; сервер проверяет получателя при открытии уведомления.
- Внешние HTTPS-сайты открываются системным браузером, телефон/email — соответствующим приложением. Неподдерживаемые схемы не запускаются.
- Google/Instagram открываются в системной OAuth-сессии, возвращаются через `basqar://oauth`; callback проверяет provider/state и проходит существующую проверку исходной серверной сессии. Сессионные токены в URL не передаются. Это подключение интеграций, не вход пользователя через Google.
- PDF и другие скачивания передаются в системное меню «Сохранить/Отправить» частями. На iOS временный файл очищается после завершения меню. На Android файл сохраняется в закрытом кеше, чтобы выбранное приложение успело его прочитать; папки старше 24 часов очищаются при следующем запуске или возвращении в BasQar. Лимит native-передачи — 20 МБ; web-лимиты загрузки на сервер не изменены. Большие выгрузки остаются доступны через веб-кабинет.
- Выгрузки CSV/Excel, клиентов и готовых документов используют тот же системный путь. PDF статистики создаётся через Expo Print из существующего отчёта (до 512 К символов HTML), затем открывается меню сохранения. Веб-версия продолжает использовать своё окно печати. Готовые подписанные документы не перегенерируются. Фактический внешний вид PDF на устройствах входит в приёмку.
- Камера, микрофон и выбор фото используют существующие web-поля и системные средства WebView. Разрешения запрашиваются при использовании. Адресная книга, геолокация и доступ ко всей медиатеке Android не запрашиваются.

Verified Universal Links / Android App Links по умолчанию выключены: нельзя публиковать фиктивный Team ID или SHA-256 сертификата. Указать реальный Team ID и fingerprint **Play App Signing**, затем выполнить:

```bash
node apps/mobile/scripts/generate-link-associations.mjs
```

Генератор создаст `apps/mobile/generated/.well-known/apple-app-site-association` и `assetlinks.json`. Разместить на `https://bsqr.kz/.well-known/` с application/json без redirects, проверить на устройствах, затем собрать с `BASQAR_VERIFIED_LINKS=1`. Только UI-маршруты перехватываются приложением: `/api` и OAuth callback должны остаться на сервере. Без verified links custom scheme и возврат OAuth работают независимо; обычные HTTPS-ссылки открываются браузером.

## Push

Используются существующие `DeviceInstallation`, `Notification`, `NotificationDelivery` и общий worker. Новая очередь или таблица не создаётся.

- Включение через меню приложения после входа и согласия ОС.
- Backend flag `MOBILE_PUSH_ENABLED=0` по умолчанию. Включать после настройки APNs/FCM и тестового устройства.
- На сервере optional `EXPO_ACCESS_TOKEN` для защищённого Expo Push Service. Он не равен публичному EAS project ID.
- События и тихие часы берутся из существующих правил. Повторы подавляются по уведомлению и устройству. Неизвестный сетевой результат не отправляется повторно вслепую.
- Различаются создание, отправка, принятие Expo, receipt, ошибка и неопределённый результат. Receipt `ok` означает передачу транспортному сервису APNs/FCM, а не прочтение человеком.
- Текст на заблокированном экране общий: без имени клиента, переписки и телефона. Payload содержит идентификаторы уведомления и компании; это тоже данные, которые нужно учесть в privacy-декларации.
- Просроченные/отозванные устройства и прочитанные уведомления пропускаются. Открытие проверяет получателя и активную компанию; чужое уведомление возвращает 404.

Регистрация, очередь, гонки, logout и переключение аккаунта проверены автоматически с подменой внешнего транспорта. Реальная доставка через APNs/FCM пока не проверена. [Expo setup](https://docs.expo.dev/push-notifications/push-notifications-setup/), [tickets/receipts](https://docs.expo.dev/push-notifications/sending-notifications/).

## Ограничения для магазинов

Мобильный выпуск — companion для существующих аккаунтов компаний. В приложении скрыта регистрация и покупка цифровой подписки BasQar через Freedom Pay. Страницы подписки показывают доступ компании; web-покупка остаётся прежней. Работа с документами и платежами клиентов CRM не изменена. IAP / Google Play Billing не реализованы; если потребуется продажа подписки внутри приложения, это отдельная задача. Выбранный подход требует подтверждения модерацией; B2B-исключение не гарантируется для всех моделей продаж. [Apple 3.1.3(c)/(f), 4.2](https://developer.apple.com/app-store/review/guidelines/), [Google Play payments](https://support.google.com/googleplay/android-developer/answer/9858738).

Подписание договоров/АВР/ЭСФ и первичная авторизация ИС ЭСФ через NCALayer требуют desktop-компонента. На телефоне эти операции теперь возвращают понятное объяснение, без попытки связаться с loopback и без ложного успеха. Черновики, просмотр и серверные операции, не требующие локальной ЭЦП, используют существующий кабинет. Мобильная ЭЦП не реализована; её нельзя заявлять в карточке магазина.

Добавлены публичная страница `/account-deletion` и запрос удаления из приложения. Запрос идемпотентно попадает в существующую поддержку и аудит; данные компании не удаляются автоматически. **До публикации оператор обязан определить срок обработки, состав сохраняемых по закону данных, выполнение удаления и сообщение о завершении.** Не нужно требовать дополнительного звонка/письма от пользователя. Сейчас нельзя утверждать, что удаление полностью автоматизировано или что запрос уже удаляет аккаунт. Apple допускает ручное исполнение в разумный срок с информированием пользователя. [Apple account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion). Для Play нужен также действующий публичный URL удаления. [Google](https://support.google.com/googleplay/android-developer/answer/13327111).

## Выпуск на рабочий сервер

1. Проверить ветку и пройти текущие acceptance workflows.
2. Развернуть совместимый API и web из этой ветки обычным процессом BasQar; схему БД менять не требуется.
3. Проверить публичный `/api/v1/mobile/config`: protocolVersion 1. Старый сервер приложение не считает совместимым и показывает понятную ошибку.
4. Проверить HTTPS, login/logout, файлы и обе OAuth-интеграции на внутренней сборке.
5. Настроить APNs/FCM, затем включить native push и проверить доставку/receipt/отзыв устройства.
6. Выполнить матрицу приёмки из `docs/mobile-store-checklist.md`.
7. Заполнить реальные store-данные, выполнить закрытое тестирование и запросить разрешение владельца на отправку.

Изменения серверной части по умолчанию не включают внешние push и не затрагивают данные production. Rollback сервера ниже protocolVersion 1 делает мобильный клиент недоступным — учитывать это при выпуске.
