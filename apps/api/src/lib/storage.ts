import { mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { ApiError } from "../errors.ts";
import path from "node:path";
import { config } from "../config.ts";

const PERSISTENT_PREFIXES = ["/var/data", "/data", "/mnt"];

export function classifyStorePathKind(
  storageDir: string,
  options?: { cwd?: string; persistentFlag?: string | null },
): "persistent" | "ephemeral" {
  const flag = String(options?.persistentFlag ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return "persistent";

  const dir = String(storageDir || "").trim();
  if (!dir) return "ephemeral";

  const resolved = path.resolve(dir).replace(/\\/g, "/");
  for (const prefix of PERSISTENT_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(`${prefix}/`)) return "persistent";
  }

  if (path.isAbsolute(dir)) {
    const cwd = path.resolve(options?.cwd || process.cwd()).replace(/\\/g, "/");
    if (resolved !== cwd && !resolved.startsWith(`${cwd}/`)) return "persistent";
  }

  return "ephemeral";
}

export function uploadsRoot() {
  if (config.storageDir) {
    return path.resolve(config.storageDir, "uploads");
  }
  return path.resolve(process.cwd(), "data", "uploads");
}

export function crmStorePathKind(): "persistent" | "ephemeral" {
  return classifyStorePathKind(config.storageDir, {
    persistentFlag: process.env.STORAGE_PERSISTENT,
  });
}

export function fileStorageStatus() {
  const storePathKind = crmStorePathKind();
  return {
    storePathKind,
    uploadsRoot: uploadsRoot(),
    storageDir: config.storageDir || null,
    warning:
      storePathKind === "ephemeral"
        ? "Файлы задач и рассылок на эфемерном диске — после рестарта Render КП пропадут. Подключите Persistent Disk и задайте STORAGE_DIR=/var/data/files."
        : null,
  };
}

export function missingFileMessage() {
  return "Файл не найден на сервере. Прикрепите КП заново и повторите отправку.";
}

export function resolveUploadPath(storageKey: string) {
  const invalid = () => new ApiError(422, "invalid_storage_path", "Недопустимый путь к файлу");
  if (!storageKey || storageKey.includes("\0") || storageKey.includes("\\")) throw invalid();
  const root = uploadsRoot();
  const candidate = path.resolve(root, storageKey);
  const inside = (base: string, target: string) => {
    const relative = path.relative(base, target);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  // Legacy absolute keys remain readable only when they are inside the configured store.
  if (!inside(root, candidate)) throw invalid();
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    let ancestor = candidate;
    while (!existsSync(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor);
    const realAncestor = realpathSync(ancestor);
    if (realAncestor !== realRoot && !inside(realRoot, realAncestor)) throw invalid();
  }
  return candidate;
}

export async function ensureUploadsRoot() {
  await mkdir(uploadsRoot(), { recursive: true, mode: 0o700 });
  return fileStorageStatus();
}
