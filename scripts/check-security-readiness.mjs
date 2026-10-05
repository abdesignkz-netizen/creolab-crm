import dotenv from "dotenv";
import { assertProductionSecurity } from "../apps/api/src/lib/productionSecurity.ts";

// Run in the intended deployment environment. Never print the values of secrets.
dotenv.config({ quiet: true });
try {
  // A temporary startup exception must never turn into a successful security sign-off.
  assertProductionSecurity({ ...process.env, NODE_ENV: "production" }, { requireStrongEncryptionKey: true });
  for (const key of ["APP_BASE_URL", "API_BASE_URL", "ALLOWED_ORIGINS", "STORAGE_DIR"]) {
    if (!process.env[key]?.trim()) throw new Error(`${key} must be explicitly configured before deployment`);
  }
  for (const origin of process.env.ALLOWED_ORIGINS.split(",")) {
    const url = new URL(origin.trim());
    if (url.protocol !== "https:" || url.origin !== origin.trim()) throw new Error("ALLOWED_ORIGINS must contain exact HTTPS origins only");
  }
  console.log("Production key and URL configuration passed. Server permissions, backups, network isolation and MFA require separate verification.");
} catch (error) {
  console.error(`Security readiness failed: ${error instanceof Error ? error.message : "invalid configuration"}`);
  process.exitCode = 1;
}
