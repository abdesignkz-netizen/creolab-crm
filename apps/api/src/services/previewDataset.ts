export const PREVIEW_DATASET = {
  situation: {
    inquiries: 12,
    inProgress: 8,
    needsAttention: 3,
    dialogs: 5,
    deals: 4,
    tasks: 6,
  },
  conversations: [
    { id: "demo-dialog-1", title: "Алия · сайт для клиники", preview: "Можем созвониться завтра после 15:00?", unread: true },
    { id: "demo-dialog-2", title: "Данияр · бренд и упаковка", preview: "Пришлите, пожалуйста, примеры работ.", unread: false },
    { id: "demo-dialog-3", title: "ТОО Рассвет · сопровождение", preview: "AI уточнил бюджет и передал менеджеру.", unread: false },
  ],
  contacts: [
    { id: "demo-contact-1", name: "Алия Сериковна", company: "Clinic Plus", status: "В диалоге" },
    { id: "demo-contact-2", name: "Данияр Оспанов", company: "Nomad Pack", status: "Новый" },
    { id: "demo-contact-3", name: "Марина Ким", company: "ТОО Рассвет", status: "Сделка" },
  ],
  deals: [
    { id: "demo-deal-1", title: "Сайт клиники", stage: "КП отправлено", amount: "1 200 000 ₸" },
    { id: "demo-deal-2", title: "Упаковка Nomad", stage: "Переговоры", amount: "850 000 ₸" },
    { id: "demo-deal-3", title: "Сопровождение Рассвет", stage: "Новая", amount: "480 000 ₸" },
  ],
  tasks: [
    { id: "demo-task-1", title: "Созвониться с Алией", due: "Сегодня, 16:00" },
    { id: "demo-task-2", title: "Отправить портфолио Данияру", due: "Завтра" },
    { id: "demo-task-3", title: "Подготовить бриф по Рассвет", due: "Пн" },
  ],
  stats: {
    newInquiries: 12,
    conversion: "18%",
    replyMinutes: 7,
  },
};

export type PreviewDataset = typeof PREVIEW_DATASET;
