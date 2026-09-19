import type { PrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { config } from "../config.ts";
import { decryptSecret } from "../lib/secretBox.ts";
import {
  aiManagerWebhookUrl,
  internalServiceSecret,
  resolveAiManagerUrl,
  type WhatsAppSellerSchema,
} from "./aiManagerConfig.ts";
import { applyGreenApiWebhookUrl } from "./greenApiWebhook.ts";
import { getPublishedTenantAiContext } from "./tenantAiConfigService.ts";

function integrationSecretPlain(schema: WhatsAppSellerSchema) {
  if (!schema.secretEnc) return "";
  try {
    return decryptSecret(schema.secretEnc);
  } catch {
    return "";
  }
}

function greenApiTokenPlain(schema: WhatsAppSellerSchema) {
  if (!schema.apiTokenEnc) return "";
  try {
    return decryptSecret(schema.apiTokenEnc);
  } catch {
    return "";
  }
}

export async function tenantAiManagerRegisterPayload(prisma: PrismaClient, tenantId: string) {
  const context = await getPublishedTenantAiContext(prisma, tenantId);
  const knowledge = context.knowledge
    .map((item) => `### ${item.title}\n${item.content}`.trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20000);
  return {
    prompt: [context.platformBasePrompt, context.tenantPrompt].filter(Boolean).join("\n\n"),
    knowledge: knowledge || "База знаний компании не задана.",
    aiConfig: {
      model: context.model,
      temperature: context.temperature,
      maxOutputTokens: context.maxOutputTokens,
    },
  };
}

export async function syncWhatsAppAiManagerRegistration(
  prisma: PrismaClient,
  tenantId: string,
  integrationId: string,
) {
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, tenantId, type: "whatsapp_seller" },
  });
  if (!integration) return { ok: false as const, registered: false, note: "WhatsApp не подключён", webhookToken: "", webhookUrl: "" };
  const schema = (integration.schemaJson || {}) as WhatsAppSellerSchema;
  const sellerUrl = resolveAiManagerUrl(schema.sellerUrl);
  const serviceSecret = internalServiceSecret();
  const instanceId = String(schema.instanceId || "").trim();
  const apiToken = greenApiTokenPlain(schema);
  const integrationSecret = integrationSecretPlain(schema);
  if (!sellerUrl) {
    return { ok: false as const, registered: false, note: "Общий AI Manager не задан. Нужен AI_MANAGER_URL.", webhookToken: "", webhookUrl: "" };
  }
  if (!instanceId || !apiToken) {
    return { ok: false as const, registered: false, note: "Укажите Instance ID и API Token Green API.", webhookToken: schema.webhookToken || "", webhookUrl: schema.webhookUrl || "" };
  }
  if (!integrationSecret) {
    return { ok: false as const, registered: false, note: "Не удалось создать секрет интеграции.", webhookToken: "", webhookUrl: "" };
  }
  if (!serviceSecret) {
    return {
      ok: false as const,
      registered: false,
      note: "Задайте INTERNAL_SERVICE_SECRET, чтобы зарегистрировать компанию в AI Manager.",
      webhookToken: schema.webhookToken || "",
      webhookUrl: schema.webhookUrl || "",
    };
  }

  const context = await tenantAiManagerRegisterPayload(prisma, tenantId);
  const registrar = new WhatsAppSellerBridge(sellerUrl, serviceSecret, { tenantId, integrationId });
  const registered = await registrar.registerIntegration(
    {
      integrationId,
      tenantId,
      greenApiInstanceId: instanceId,
      greenApiToken: apiToken,
      integrationSecret,
      crmEventsUrl: `${config.apiBaseUrl}/api/v1/integrations/seller-events/${integrationId}`,
      prompt: context.prompt,
      knowledge: context.knowledge,
      webhookToken: schema.webhookToken || undefined,
      aiConfig: context.aiConfig,
    },
    { serviceSecret },
  );
  if (registered.unsupported) {
    return {
      ok: false as const,
      registered: false,
      note: "AI Manager отвечает, но маршрут регистрации интеграций на нём ещё не включён.",
      webhookToken: "",
      webhookUrl: "",
    };
  }

  const webhookToken = String(registered.integration?.webhookToken || schema.webhookToken || "").trim();
  const webhookUrl = aiManagerWebhookUrl(sellerUrl, webhookToken);
  let note = "Компания зарегистрирована в общем AI Manager.";
  let webhookOk = false;
  if (webhookUrl) {
    const applied = await applyGreenApiWebhookUrl({
      instanceId,
      apiToken,
      webhookUrl,
      apiHost: schema.greenApiHost,
    });
    webhookOk = applied.ok;
    if (applied.ok && applied.host) {
      note = `Компания зарегистрирована. Webhook Green API: ${webhookUrl}`;
      schema.greenApiHost = applied.host;
    } else {
      note = `Компания зарегистрирована в AI Manager, но webhook Green API не выставился (${applied.error || "ошибка"}). Нужен адрес ${webhookUrl}`;
    }
  }

  const nextSchema: WhatsAppSellerSchema = {
    ...schema,
    sellerUrl,
    webhookToken,
    webhookUrl,
  };
  await prisma.integration.update({
    where: { id: integrationId },
    data: { schemaJson: nextSchema },
  });

  return {
    ok: Boolean(webhookToken) && webhookOk,
    note,
    webhookToken,
    webhookUrl,
    registered: true,
  };
}
