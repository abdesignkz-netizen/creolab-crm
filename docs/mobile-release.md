# Мобильные сборки

Приложение: `apps/mobile`, Expo SDK 53, Expo Router.

Идентификаторы (dev, задаются конфигом):

- iOS `kz.creolab.crm.dev`
- Android `kz.creolab.crm.dev`
- scheme `creolabcrm`
- Deep links: `https://bsqr.kz/...`; `https://crm.creolab.kz/...` сохранён на переходный период.
- Для Universal Links / App Links нужны AASA/assetlinks на обоих доменах с реальными
  Apple Team ID / Android certificate fingerprints и новая native-сборка. Конфигурация Expo
  сама по себе не подтверждает работоспособность ссылок. См. [перенос домена](domain-migration-bsqr-2026-09-25.md).

Публичный конфиг содержит только `apiBaseUrl`. Refresh token — в SecureStore, не в AsyncStorage.

## Команды

```bash
npm run dev:mobile
```

Development build (не Expo Go) нужен для native push.

## Что проверено

- Код экранов: вход, Сегодня, Входящие (заявка с телефоном → принять → сделка), Сделки, Задачи.
- Авторизация mobile: access + refresh.

## Что не проверено

- Установка на физический iPhone/Android
- Подпись и аккаунты Apple/Google
- APNs/FCM credentials
- Холодный старт из push
- Universal Links / App Links на реальном домене

Сборка, установка, push и публикация — разные статусы. Веб-превью не заменяет мобильный релиз.
