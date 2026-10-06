import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "creolab-tests-"));
const requested = new Set(process.argv.slice(2).map(value => value.replace(/\.test\.ts$/, "")));
const files = ["apps/api/src", "packages/contracts/src"].flatMap((dir) =>
  readdirSync(join(root, dir)).filter((name) => name.endsWith(".test.ts")).sort().map((name) => join(dir, name)),
).filter(file => !requested.size || requested.has(file.split("/").at(-1).replace(/\.test\.ts$/, "")));
if (!files.length) throw new Error("No matching test files");
let failures = 0;
try {
  for (const [index, file] of files.entries()) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", file], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "test",
        BILLING_PROVIDER: "none",
        FREEDOM_PAY_MERCHANT_ID: "",
        FREEDOM_PAY_SECRET_KEY: "",
        FREEDOM_PAY_RECURRING_ENABLED: "0",
        FREEDOM_PAY_TESTING_MODE: "1",
        BILLING_KASPI_MANUAL_ENABLED: "0",
        CRM_USE_PGLITE: "1",
        CRM_PGLITE_DIR: join(scratch, String(index)),
        STORAGE_DIR: join(scratch, "uploads", String(index)),
        SEED_PASSWORD: "ChangeMeLocal1!",
        PLATFORM_ADMIN_EMAIL: "",
        PLATFORM_ADMIN_PASSWORD: "",
        WHATSAPP_SELLER_URL: "",
        WHATSAPP_SELLER_SECRET: "",
        AI_MANAGER_URL: "",
        ESF_PROVIDER: "mock",
        ESF_ENV: "off",
        ESF_ALLOW_LIVE_SEND: "0",
        VAPID_PUBLIC_KEY: "",
        VAPID_PRIVATE_KEY: "",
        OPENAI_API_KEY: "",
        ANYMODEL_API_KEY: "",
        TRANSCRIPTION_API_KEY: "",
        TRANSCRIPTION_ENGINE: "local",
        TRANSCRIPTION_PYTHON: "/nonexistent/basqar-test-python",
        TRANSCRIPTION_MODEL_PATH: "/nonexistent/basqar-test-speech-model",
      },
    });
    if (result.status !== 0) failures += 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${files.length - failures}/${files.length} test files passed (isolated databases; external providers disabled).`);
process.exitCode = failures ? 1 : 0;
