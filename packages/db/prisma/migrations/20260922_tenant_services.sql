CREATE TABLE IF NOT EXISTS "TenantServiceCategory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "aliases" JSONB NOT NULL DEFAULT '[]',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "TenantServiceCategory_tenantId_code_key" ON "TenantServiceCategory"("tenantId", "code");
CREATE INDEX IF NOT EXISTS "TenantServiceCategory_tenantId_active_idx" ON "TenantServiceCategory"("tenantId", "active");
