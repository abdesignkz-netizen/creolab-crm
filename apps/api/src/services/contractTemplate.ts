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

export async function ensureDefaultTemplate(prisma: PrismaClient, tenantId: string) {
  const existing = await prisma.contractTemplate.findFirst({
    where: { tenantId, isDefault: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  return prisma.contractTemplate.create({
    data: {
      tenantId,
      name: "Договор оказания услуг",
      body: DEFAULT_CONTRACT_BODY,
      isDefault: true,
    },
  });
}
