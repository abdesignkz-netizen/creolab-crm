import { createHash } from "node:crypto";
import type { Prisma } from "@creolab/db";
import type { z } from "zod";
import type { updateTenantOpsSchema } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { PIPELINE_STAGES, parseOpsSettings, type TenantOpsSettings } from "./dealPipeline.ts";

export type PipelineInput = NonNullable<z.infer<typeof updateTenantOpsSchema>["pipeline"]>;
type DealStage = Prisma.DealStageGetPayload<Record<string, never>>;
const builtInKeys = new Set(PIPELINE_STAGES.map(stage => stage.systemKey));
export const isBuiltInStage = (key: string) => builtInKeys.has(key);

// Include operational rules so saving a stale editor cannot replace someone
// else's calendar, stage order or SLA. Keys and rows have deterministic order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function processSettingsRevision(settings: unknown, timezone: string, stages: DealStage[]) {
  return createHash("sha256").update(JSON.stringify(canonical({ ops: parseOpsSettings(settings), timezone,
    stages: [...stages].sort((a, b) => a.id.localeCompare(b.id)) }))).digest("hex");
}

/** Caller holds the Tenant lock. Stage locks also coordinate manual transfers. */
export async function savePipeline(tx: Prisma.TransactionClient, tenantId: string, input: PipelineInput, existing: DealStage[], ops: TenantOpsSettings) {
  const keys = new Set(input.map(stage => stage.systemKey));
  const ids = input.filter(stage => stage.id).map(stage => stage.id);
  if (keys.size !== input.length || new Set(ids).size !== ids.length) throw new ApiError(422, "invalid", "Этапы не должны повторяться.");
  const current = new Map(existing.filter(stage => !stage.isTerminal).map(stage => [stage.systemKey, stage]));
  if ([...current.keys()].some(key => !keys.has(key))) throw new ApiError(422, "invalid", "Существующий этап можно архивировать, но нельзя удалить из истории.");
  const active = input.filter(stage => !stage.isArchived);
  if (active.length > 30) throw new ApiError(422, "invalid", "В воронке может быть не больше 30 активных этапов.");
  const names = active.map(stage => stage.name.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("ru"));
  if (new Set(names).size !== names.length) throw new ApiError(422, "invalid", "Названия активных этапов должны отличаться.");
  const anchors = active.filter(stage => isBuiltInStage(stage.systemKey)).map(stage => stage.systemKey);
  if (active[0]?.systemKey !== "new" || anchors.join() !== PIPELINE_STAGES.map(stage => stage.systemKey).join()) {
    throw new ApiError(422, "invalid", "Основные этапы должны идти от новой сделки до счёта. Дополнительные этапы можно размещать между ними.");
  }
  for (const stage of input) {
    const before = current.get(stage.systemKey);
    if (before ? stage.id !== before.id : stage.id || !/^custom_[a-f0-9-]{36}$/.test(stage.systemKey) || existing.some(row => row.systemKey === stage.systemKey) || stage.isArchived) {
      throw new ApiError(422, "invalid", "Неизвестный этап воронки.");
    }
    if (isBuiltInStage(stage.systemKey) && stage.isArchived) throw new ApiError(422, "invalid", "Основной этап связан с автоматизацией и не может быть архивирован.");
    if (before && stage.isArchived && !before.isArchived && await tx.deal.count({ where: { tenantId, stageId: before.id, outcome: { in: ["open", "on_hold"] } } })) {
      throw new ApiError(409, "stage_in_use", "На этапе есть открытые или отложенные сделки. Сначала переведите их на другой этап.");
    }
  }
  // Validation of the entire change is complete before any write.
  for (const [index, stage] of input.entries()) {
    const before = current.get(stage.systemKey);
    const data = { name: stage.name, defaultProbability: stage.defaultProbability, isArchived: stage.isArchived, sortOrder: index + 1 };
    if (before) await tx.dealStage.update({ where: { id: before.id }, data });
    else await tx.dealStage.create({ data: { tenantId, systemKey: stage.systemKey, ...data } });
    ops.stageSlaDays[stage.systemKey] = stage.slaDays;
  }
}
