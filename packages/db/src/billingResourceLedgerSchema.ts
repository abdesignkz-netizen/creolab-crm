// Shared by live PostgreSQL patches and PGlite initialization.
export const BILLING_RESOURCE_LEDGER_SQL = [
`CREATE TABLE IF NOT EXISTS "BillingResourceUsage" (
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  resource TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  period TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("tenantId", resource, "operationId")
)`,
`CREATE INDEX IF NOT EXISTS "BillingResourceUsage_period_idx" ON "BillingResourceUsage" ("tenantId", resource, period)`,
// Anniversary months, including Jan 31 -> Feb 28 -> Mar 31. Calendar months for old rows without an anchor.
`CREATE OR REPLACE FUNCTION basqar_resource_period(anchor TEXT, at_time TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE a TIMESTAMPTZ; months INTEGER; boundary TIMESTAMPTZ;
BEGIN
  IF anchor IS NULL THEN RETURN to_char(at_time AT TIME ZONE 'Asia/Almaty', 'YYYY-MM'); END IF;
  a := anchor::timestamptz;
  months := (extract(year FROM at_time AT TIME ZONE 'UTC') - extract(year FROM a AT TIME ZONE 'UTC')) * 12
    + extract(month FROM at_time AT TIME ZONE 'UTC') - extract(month FROM a AT TIME ZONE 'UTC');
  boundary := (a AT TIME ZONE 'UTC' + make_interval(months => months)) AT TIME ZONE 'UTC';
  IF boundary > at_time THEN boundary := (a AT TIME ZONE 'UTC' + make_interval(months => months - 1)) AT TIME ZONE 'UTC'; END IF;
  RETURN to_char(boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END $$`,
`CREATE OR REPLACE FUNCTION basqar_document_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u "TenantUsage"%ROWTYPE; cap NUMERIC; used BIGINT; bucket TEXT;
BEGIN
  SELECT * INTO u FROM "TenantUsage" WHERE "tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  cap := (u."limitsJson"->>'DOCUMENTS_COUNT')::numeric;
  IF cap IS NULL THEN RETURN NEW; END IF; -- Old contracts retain their agreed rights.
  IF EXISTS (SELECT 1 FROM "BillingResourceUsage" WHERE "tenantId" = NEW."tenantId"
    AND resource = 'DOCUMENTS_COUNT' AND "operationId" = TG_TABLE_NAME || ':' || NEW.id) THEN RETURN NEW; END IF;
  bucket := basqar_resource_period(u."countersJson"->>'resourceAnchor');
  SELECT COALESCE(sum(amount),0) INTO used FROM "BillingResourceUsage"
    WHERE "tenantId" = NEW."tenantId" AND resource = 'DOCUMENTS_COUNT' AND period = bucket;
  IF cap >= 0 AND used + 1 > cap THEN RAISE EXCEPTION 'BASQAR_LIMIT:DOCUMENTS_COUNT'; END IF;
  INSERT INTO "BillingResourceUsage" ("tenantId", resource, "operationId", period, amount)
    VALUES (NEW."tenantId", 'DOCUMENTS_COUNT', TG_TABLE_NAME || ':' || NEW.id, bucket, 1);
  RETURN NEW;
END $$`,
...['Contract', 'Invoice', 'ElectronicDocument'].map(table =>
  `CREATE OR REPLACE TRIGGER basqar_document_quota BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION basqar_document_quota()`),
];
