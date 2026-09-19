import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type SupportArticleSeed = {
  slug: string;
  category: string;
  title: string;
  content: string;
  keywords: string;
  sortOrder: number;
  isPopular: boolean;
  relatedRoute: string | null;
  relatedLabel: string | null;
};

export const SUPPORT_CATEGORIES = [
  { id: "getting-started", title: "Начало работы" },
  { id: "whatsapp", title: "WhatsApp" },
  { id: "ai", title: "AI-менеджер" },
  { id: "conversations", title: "Диалоги" },
  { id: "inquiries", title: "Заявки" },
  { id: "deals", title: "Сделки" },
  { id: "tasks", title: "Задачи" },
  { id: "clients", title: "Клиенты" },
  { id: "team", title: "Команда" },
  { id: "integrations", title: "Интеграции" },
  { id: "documents", title: "Документы" },
  { id: "avr", title: "АВР" },
  { id: "esf", title: "ЭСФ" },
  { id: "stats", title: "Статистика" },
  { id: "settings", title: "Настройки" },
  { id: "billing", title: "Оплата" },
  { id: "security", title: "Безопасность" },
] as const;

export const SUPPORT_ARTICLES: SupportArticleSeed[] = [
  {
    slug: "connect-whatsapp",
    category: "whatsapp",
    title: "Как подключить WhatsApp?",
    keywords: "whatsapp ватсап вацап green api instance id token подключить бот",
    sortOrder: 10,
    isPopular: true,
    relatedRoute: "/integrations",
    relatedLabel: "Открыть Интеграции",
    content: `WhatsApp в BasQar — канал общения с клиентами компании. Это не чат с поддержкой сервиса.

1. Откройте «Интеграции».
2. В блоке «WhatsApp» нажмите «Подключить».
3. Укажите Instance ID и API Token из личного кабинета Green API.
4. Нажмите «Подключить» и дождитесь статуса «Подключён».
5. При необходимости нажмите «Забрать диалоги из бота», чтобы подтянуть уже существующие переписки.

Подключать WhatsApp может администратор или директор компании. Instance ID и токен на сервер поддержки автоматически не передаются.`,
  },
  {
    slug: "ai-manager",
    category: "ai",
    title: "Как работает AI-менеджер?",
    keywords: "ai менеджер ии автоответ бот продажи",
    sortOrder: 20,
    isPopular: true,
    relatedRoute: "/control",
    relatedLabel: "Открыть Управление",
    content: `AI-менеджер отвечает клиентам компании в WhatsApp и помогает обрабатывать заявки. Он не отвечает за поддержку самого BasQar.

Где смотреть:
• «Управление» — сколько диалогов ведёт AI, сколько ждут сотрудника, пауза и массовая передача.
• «Диалоги» — конкретная переписка с клиентом.
• «Настройки → AI-менеджер» — как обрабатывать новые заявки с формы сайта.

AI пишет клиенту только если WhatsApp подключён и для диалога включён режим AI.`,
  },
  {
    slug: "pause-ai",
    category: "ai",
    title: "Как временно остановить AI?",
    keywords: "пауза остановить выключить ai менеджер не отвечает",
    sortOrder: 30,
    isPopular: true,
    relatedRoute: "/control",
    relatedLabel: "Открыть Управление",
    content: `1. Откройте «Управление».
2. Нажмите «Приостановить AI».
3. Подтвердите действие.

После паузы AI не отвечает клиентам автоматически. Входящие сообщения и заявки продолжают сохраняться в CRM. Чтобы снова включить ответы, нажмите «Возобновить AI».

Приостановить AI может администратор или директор, не менеджер.`,
  },
  {
    slug: "take-dialog",
    category: "conversations",
    title: "Как забрать диалог у AI?",
    keywords: "забрать диалог человеку takeover human передать менеджеру",
    sortOrder: 40,
    isPopular: true,
    relatedRoute: "/conversations",
    relatedLabel: "Открыть Диалоги",
    content: `Чтобы отвечать клиенту самостоятельно:

1. Откройте «Диалоги» и выберите переписку.
2. Передайте диалог сотруднику — AI перестанет отвечать в этой переписке.
3. Или в «Управление» нажмите «Забрать все диалоги у AI», если нужно остановить автоответы сразу во всех активных диалогах.

Это касается только переписок компании с её клиентами, не обращений в поддержку BasQar.`,
  },
  {
    slug: "return-dialog",
    category: "conversations",
    title: "Как вернуть диалог AI?",
    keywords: "вернуть ai автоответ режим бот",
    sortOrder: 50,
    isPopular: true,
    relatedRoute: "/conversations",
    relatedLabel: "Открыть Диалоги",
    content: `1. Откройте «Диалоги» и нужную переписку.
2. Верните диалог AI — автоматические ответы снова включится для этого клиента.

Если AI на паузе в «Управлении», сначала возобновите AI, иначе автоответы не пойдут.`,
  },
  {
    slug: "create-inquiry",
    category: "inquiries",
    title: "Как создать заявку?",
    keywords: "заявка обращение лид форма сайта создать",
    sortOrder: 60,
    isPopular: true,
    relatedRoute: "/inquiries",
    relatedLabel: "Открыть Заявки",
    content: `Заявки появляются сами с формы сайта и из WhatsApp. Добавить вручную:

1. Откройте «Заявки».
2. Создайте обращение: имя, телефон и кратко, что нужно клиенту.
3. Заявка попадёт в работу команды и может превратиться в сделку.

Форма сайта подключается в «Интеграции». Это не Webhook API и не чат поддержки.`,
  },
  {
    slug: "create-deal",
    category: "deals",
    title: "Как создать сделку?",
    keywords: "сделка воронка создать продажа",
    sortOrder: 70,
    isPopular: true,
    relatedRoute: "/deals",
    relatedLabel: "Открыть Сделки",
    content: `1. Откройте «Сделки».
2. Нажмите создание сделки, укажите название и клиента.
3. Сделку можно также получить из заявки — кнопкой перевода заявки в сделку.

Дальше по сделке ведутся этапы, задачи, договор, счёт и АВР.`,
  },
  {
    slug: "change-deal-stage",
    category: "deals",
    title: "Как изменить этап сделки?",
    keywords: "этап воронка статус сделки сдвинуть",
    sortOrder: 80,
    isPopular: true,
    relatedRoute: "/deals",
    relatedLabel: "Открыть Сделки",
    content: `1. Откройте «Сделки» и карточку нужной сделки.
2. Смените этап в карточке — сделка переместится по воронке.
3. На Главной и в «Статистике» этапы видны в сводке.

Не путайте этап сделки со статусом документов (договор, счёт, АВР).`,
  },
  {
    slug: "create-task",
    category: "tasks",
    title: "Как создать задачу?",
    keywords: "задача поручение напомнить позвонить написать",
    sortOrder: 90,
    isPopular: true,
    relatedRoute: "/tasks",
    relatedLabel: "Открыть Задачи",
    content: `1. Откройте «Задачи».
2. Опишите задачу своими словами или выберите клиента и действие.
3. Система создаст задачу, при необходимости подготовит сообщение в WhatsApp.

Из задачи можно написать клиенту, отправить КП и закрыть работу. Массовая рассылка по списку номеров — тоже в «Задачах».`,
  },
  {
    slug: "add-member",
    category: "team",
    title: "Как добавить сотрудника?",
    keywords: "сотрудник пригласить команда роль менеджер доступ",
    sortOrder: 100,
    isPopular: true,
    relatedRoute: "/settings?section=members",
    relatedLabel: "Открыть сотрудников",
    content: `1. Откройте «Настройки».
2. Раздел «Сотрудники, роли и права».
3. Пригласите человека по email и выберите роль: директор, руководитель продаж или менеджер.

Приглашение принимает сам сотрудник. Добавлять людей может администратор компании.`,
  },
  {
    slug: "view-clients",
    category: "clients",
    title: "Как посмотреть клиентов?",
    keywords: "клиенты контакты база карточка",
    sortOrder: 110,
    isPopular: true,
    relatedRoute: "/contacts",
    relatedLabel: "Открыть Клиенты",
    content: `1. Откройте «Клиенты» — люди, с которыми вы общаетесь.
2. «Компании» — юридические лица и реквизиты.
3. Карточка клиента показывает переписки, заявки, сделки и задачи.

Клиенты появляются из WhatsApp, формы сайта и при ручном создании.`,
  },
  {
    slug: "situation",
    category: "getting-started",
    title: "Как работает раздел «Ситуация»?",
    keywords: "главная ситуация сводка внимание сегодня",
    sortOrder: 120,
    isPopular: true,
    relatedRoute: "/today",
    relatedLabel: "Открыть Главную",
    content: `Главная («Ситуация») — оперативная картина дня:

• что требует внимания;
• кто ждёт ответа;
• просроченные задачи;
• новые заявки;
• зависшие сделки.

Цифры в меню ведут сразу в нужный фильтр. Это обзор работы компании, а не чат с клиентом и не поддержка BasQar.`,
  },
  {
    slug: "stats",
    category: "stats",
    title: "Как посмотреть статистику?",
    keywords: "статистика отчёт воронка конверсия",
    sortOrder: 130,
    isPopular: true,
    relatedRoute: "/stats",
    relatedLabel: "Открыть Статистику",
    content: `1. Откройте «Статистика».
2. Выберите период.
3. Смотрите заявки, сделки, источники и потери между этапами.

Раздел доступен администратору и директору, не менеджеру.`,
  },
  {
    slug: "create-avr",
    category: "avr",
    title: "Как создать АВР?",
    keywords: "авр акт выполненных работ документ закрытие",
    sortOrder: 140,
    isPopular: true,
    relatedRoute: "/documents",
    relatedLabel: "Открыть Документы",
    content: `1. Откройте сделку или раздел «Документы».
2. Сформируйте АВР по сделке — позиции и реквизиты подставятся из сделки и компании.
3. Проверьте данные и при необходимости отправьте в ИС ЭСФ.

Для отправки в ИС ЭСФ кабинет должен быть подключён в «Интеграции → ИС ЭСФ», а на компьютере запущен NCALayer.`,
  },
  {
    slug: "connect-esf",
    category: "esf",
    title: "Как подключить ЭСФ?",
    keywords: "эсф исв эцп ncalayer кабинет кгд",
    sortOrder: 150,
    isPopular: true,
    relatedRoute: "/integrations/esf",
    relatedLabel: "Открыть ИС ЭСФ",
    content: `1. В «Настройках» включите контур ИС ЭСФ в реквизитах компании и заполните БИН.
2. Откройте «Интеграции → ИС ЭСФ».
3. Запустите NCALayer на этом компьютере.
4. Нажмите «Подключить через NCALayer» и подпишите вход ЭЦП. PIN вводится только в NCALayer, на сервер он не уходит.

Подпись АВР/ЭСФ и вход в кабинет — разные операции. Тестовый стенд КГД использует собственные действующие ключи НУЦ вашей организации.`,
  },
  {
    slug: "connect-integration",
    category: "integrations",
    title: "Как подключить интеграцию?",
    keywords: "интеграции форма сайта tilda whatsapp эсф",
    sortOrder: 160,
    isPopular: true,
    relatedRoute: "/integrations",
    relatedLabel: "Открыть Интеграции",
    content: `В «Интеграциях» сейчас доступно:

• форма сайта (HTML, существующая форма, JavaScript, Tilda);
• WhatsApp;
• кабинет ИС ЭСФ.

Скопируйте адрес для заявок и поставьте его в action формы или Webhook Tilda. Поля: name, phone, message, company.

Telegram, Instagram и Webhook API для пользователей сервиса не показываются — их подключает администратор BasQar, если это нужно.`,
  },
  {
    slug: "whatsapp-control",
    category: "ai",
    title: "Как работает управление через WhatsApp?",
    keywords: "управление whatsapp команды менеджера режим ai",
    sortOrder: 170,
    isPopular: true,
    relatedRoute: "/control",
    relatedLabel: "Открыть Управление",
    content: `Клиенты пишут в WhatsApp. Вы управляете этим из CRM:

• «Управление» — пауза AI и передача всех диалогов сотрудникам.
• «Диалоги» — забрать одну переписку, вернуть AI, посмотреть историю.
• «Задачи» — исходящие сообщения и файлы клиенту.

Кабинет не шлёт сообщения в обход подключённого WhatsApp. Если бот не подключён, задачи и заявки создавать можно, а отправка в WhatsApp станет доступна после подключения в «Интеграциях».`,
  },
  {
    slug: "mass-campaign",
    category: "tasks",
    title: "Как отправить массовую рассылку?",
    keywords: "рассылка массовая кампания список номеров",
    sortOrder: 180,
    isPopular: true,
    relatedRoute: "/tasks",
    relatedLabel: "Открыть Задачи",
    content: `1. Откройте «Задачи».
2. Выберите массовую отправку.
3. Укажите получателей: список номеров, группа из CRM или выбранные клиенты.
4. Напишите текст, при необходимости прикрепите файл.
5. Проверьте черновик и подтвердите отправку или отложенный запуск.

Рассылка идёт через подключённый WhatsApp. Менеджеру этот режим недоступен.`,
  },
  {
    slug: "company-settings",
    category: "settings",
    title: "Как изменить настройки компании?",
    keywords: "настройки реквизиты бин сотрудники компания",
    sortOrder: 190,
    isPopular: true,
    relatedRoute: "/settings",
    relatedLabel: "Открыть Настройки",
    content: `«Настройки» делятся на личные и компании.

Личные: профиль, пароль, уведомления, язык и оформление.

Компании (для администратора и директора):
• реквизиты — БИН, адрес, банк, подпись и печать;
• сотрудники и роли;
• AI-менеджер — как обрабатывать новые заявки;
• ссылка на «Интеграции».`,
  },
  {
    slug: "contact-support",
    category: "getting-started",
    title: "Как обратиться в поддержку?",
    keywords: "поддержка помощь написать чат basqar",
    sortOrder: 200,
    isPopular: true,
    relatedRoute: null,
    relatedLabel: null,
    content: `1. Нажмите «Помощь» в кабинете.
2. Найдите ответ в статьях или сразу нажмите «Написать в поддержку».
3. Опишите вопрос. Можно приложить скриншот или файл.
4. Ответ придёт в этот же чат, в колокольчике появится уведомление.

Это переписка с командой BasQar. Она не попадает в «Диалоги» с вашими клиентами, в заявки и в сделки.`,
  },
];

export const SUPPORT_QUICK_REPLIES = [
  {
    shortcut: "/whatsapp",
    title: "WhatsApp",
    content:
      "Откройте «Интеграции» → WhatsApp → «Подключить» и укажите Instance ID и API Token из Green API. После сохранения статус должен стать «Подключён».",
    sortOrder: 10,
  },
  {
    shortcut: "/esf",
    title: "ЭСФ",
    content:
      "Заполните БИН в реквизитах, включите контур ИС ЭСФ, откройте «Интеграции → ИС ЭСФ», запустите NCALayer и подключитесь ЭЦП. PIN вводится только в NCALayer.",
    sortOrder: 20,
  },
  {
    shortcut: "/ai",
    title: "AI-менеджер",
    content:
      "Пауза и массовая передача диалогов — в «Управление». Одну переписку забирают в «Диалогах». Настройки обработки заявок — «Настройки → AI-менеджер».",
    sortOrder: 30,
  },
  {
    shortcut: "/deal",
    title: "Сделка",
    content:
      "Сделки создаются в разделе «Сделки» или из заявки. Этап меняется в карточке сделки. Договор, счёт и АВР — в сделке и в «Документах».",
    sortOrder: 40,
  },
];

export async function upsertSupportCatalog(prisma: PrismaClient) {
  for (const article of SUPPORT_ARTICLES) {
    await prisma.supportArticle.upsert({
      where: { slug: article.slug },
      update: {
        category: article.category,
        title: article.title,
        content: article.content,
        keywords: article.keywords,
        sortOrder: article.sortOrder,
        isPopular: article.isPopular,
        isPublished: true,
        relatedRoute: article.relatedRoute,
        relatedLabel: article.relatedLabel,
      },
      create: {
        id: randomUUID(),
        ...article,
        isPublished: true,
      },
    });
  }
  for (const reply of SUPPORT_QUICK_REPLIES) {
    await prisma.supportQuickReply.upsert({
      where: { shortcut: reply.shortcut },
      update: {
        title: reply.title,
        content: reply.content,
        sortOrder: reply.sortOrder,
        isActive: true,
      },
      create: {
        id: randomUUID(),
        ...reply,
        isActive: true,
      },
    });
  }
}
