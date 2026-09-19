import type { PrismaClient } from "@creolab/db";

export const DEFAULT_CONTRACT_BODY = `{{seller_name}}, БИН {{seller_bin}}, адрес: {{seller_address}}, в лице {{seller_director}}, именуемое в дальнейшем «Исполнитель», и {{buyer_name}}, БИН {{buyer_bin}}, адрес: {{buyer_address}}, именуемое в дальнейшем «Заказчик», заключили настоящий договор о нижеследующем.

1. Предмет договора
Исполнитель обязуется оказать услуги по сделке «{{deal_name}}»: {{subject}}.

{{items_table}}

2. Стоимость и расчёты
Общая стоимость услуг составляет {{amount}} ({{amount_words}}), {{vat}}.

3. Порядок оплаты
{{payment_terms}}

4. Сроки оказания услуг
{{completion_terms}}

5. Заключительные положения
Настоящий договор составлен в двух экземплярах, имеющих одинаковую юридическую силу.`;

export function isShortCrmContractStub(body: string) {
  const text = String(body || "");
  return text.length < 1500 && /5\.\s*Заключительные положения/.test(text) && /\{\{\s*items_table\s*\}\}/.test(text);
}

export function isFullContractTemplateBody(body: string) {
  const text = String(body || "");
  return text.length > 800 && /реквизит|приложение\s*№|предмет\s+договор/i.test(text) && !isShortCrmContractStub(text);
}

export async function ensureDefaultTemplate(prisma: PrismaClient, tenantId: string) {
  const templates = await prisma.contractTemplate.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
  });
  const full = templates.find((row) => isFullContractTemplateBody(row.body));
  const currentDefault = templates.find((row) => row.isDefault) || null;
  if (full && (!currentDefault || isShortCrmContractStub(currentDefault.body))) {
    await prisma.contractTemplate.updateMany({
      where: { tenantId, isDefault: true },
      data: { isDefault: false },
    });
    return prisma.contractTemplate.update({ where: { id: full.id }, data: { isDefault: true } });
  }
  if (currentDefault) return currentDefault;
  if (templates[0]) {
    return prisma.contractTemplate.update({ where: { id: templates[0].id }, data: { isDefault: true } });
  }
  return prisma.contractTemplate.create({
    data: {
      tenantId,
      name: "Короткий шаблон CRM",
      body: DEFAULT_CONTRACT_BODY,
      isDefault: true,
    },
  });
}
