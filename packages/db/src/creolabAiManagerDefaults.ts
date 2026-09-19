import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";

export const CREOLAB_KNOWLEDGE_TITLE = "База знаний CreoLab";
export const CREOLAB_KNOWLEDGE_ID = "creolab-whatsapp-knowledge";

function assetsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "../assets/creolab-ai");
}

export function readCreolabAiManagerDefaults() {
  const dir = assetsDir();
  return {
    prompt: readFileSync(join(dir, "system_prompt.txt"), "utf8"),
    knowledge: readFileSync(join(dir, "knowledge_base.txt"), "utf8"),
  };
}

export async function applyCreolabAiManagerDefaults(prisma: PrismaClient, tenantId: string) {
  const { prompt, knowledge } = readCreolabAiManagerDefaults();
  const existing = await prisma.aIConfiguration.findFirst({ where: { tenantId } });
  const data = {
    enabled: true,
    systemPrompt: prompt,
    draftPrompt: prompt,
    promptStatus: "published" as const,
    promptUpdatedAt: new Date(),
  };
  if (existing) {
    await prisma.aIConfiguration.update({ where: { id: existing.id }, data });
  } else {
    await prisma.aIConfiguration.create({ data: { id: `${tenantId}-ai`, tenantId, ...data } });
  }

  const doc =
    (await prisma.knowledgeDocument.findFirst({ where: { id: CREOLAB_KNOWLEDGE_ID } })) ||
    (await prisma.knowledgeDocument.findFirst({ where: { tenantId, title: CREOLAB_KNOWLEDGE_TITLE } }));
  if (doc) {
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: {
        tenantId,
        title: CREOLAB_KNOWLEDGE_TITLE,
        content: knowledge,
        sourceType: "document",
        status: "published",
        publishedAt: doc.publishedAt || new Date(),
      },
    });
  } else {
    await prisma.knowledgeDocument.create({
      data: {
        id: CREOLAB_KNOWLEDGE_ID,
        tenantId,
        title: CREOLAB_KNOWLEDGE_TITLE,
        content: knowledge,
        sourceType: "document",
        status: "published",
        publishedAt: new Date(),
      },
    });
  }
}
