-- Add QR sessions and include every WhatsApp provider in the atomic quota guard.
ALTER TABLE "OutboundOperation" ADD COLUMN IF NOT EXISTS "requestHash" TEXT;

CREATE TABLE IF NOT EXISTS "WhatsAppQrSession" (
    "integrationId" TEXT PRIMARY KEY REFERENCES "Integration"("id") ON DELETE CASCADE,
    "owner" TEXT, "leaseUntil" TIMESTAMPTZ, "encryptedQr" TEXT, "qrExpiresAt" TIMESTAMPTZ,
    "reconnectAt" TIMESTAMPTZ, "attempts" INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS "WhatsAppQrKey" (
    "integrationId" TEXT NOT NULL REFERENCES "WhatsAppQrSession"("integrationId") ON DELETE CASCADE,
    "key" TEXT NOT NULL, "encryptedValue" TEXT NOT NULL,
    PRIMARY KEY ("integrationId", "key")
  );

CREATE TABLE IF NOT EXISTS "WhatsAppQrJob" (
    "id" TEXT PRIMARY KEY, "integrationId" TEXT NOT NULL REFERENCES "WhatsAppQrSession"("integrationId") ON DELETE CASCADE,
    "kind" TEXT NOT NULL, "encryptedPayload" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued', "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

CREATE INDEX IF NOT EXISTS "WhatsAppQrJob_pending" ON "WhatsAppQrJob" ("integrationId", "state", "createdAt");

CREATE OR REPLACE FUNCTION basqar_quota_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n JSONB; o JSONB; tid TEXT; u "TenantUsage"%ROWTYPE;
  counter_key TEXT; delta BIGINT := 0; next_value BIGINT; cap NUMERIC;
  bytes_delta BIGINT; files_delta BIGINT := 0;
  month_key TEXT := to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Almaty', 'YYYY-MM');
BEGIN
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  tid := COALESCE(n->>'tenantId', o->>'tenantId');
  SELECT * INTO u FROM "TenantUsage" WHERE "tenantId" = tid FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND n->>'tenantId' IS DISTINCT FROM o->>'tenantId' THEN
    RAISE EXCEPTION 'Tenant ownership cannot change';
  END IF;

  IF u.period <> month_key THEN
    u.period := month_key;
    u."countersJson" := jsonb_set(u."countersJson", '{MONTHLY_LEADS}', '0');
  END IF;
  IF TG_TABLE_NAME = 'Contact' THEN
    counter_key := 'CLIENTS'; delta := (n IS NOT NULL)::int - (o IS NOT NULL)::int;
  ELSIF TG_TABLE_NAME = 'Deal' THEN
    counter_key := 'ACTIVE_DEALS';
    delta := COALESCE((n->>'outcome' = 'open' AND n->>'closedAt' IS NULL)::int,0)
           - COALESCE((o->>'outcome' = 'open' AND o->>'closedAt' IS NULL)::int,0);
  ELSIF TG_TABLE_NAME = 'Membership' THEN
    counter_key := 'USERS'; delta := COALESCE((n->>'active')::boolean::int,0) - COALESCE((o->>'active')::boolean::int,0);
  ELSIF TG_TABLE_NAME = 'Integration' THEN
    counter_key := 'WHATSAPP_CONNECTIONS';
    delta := COALESCE((n->>'type' IN ('whatsapp_seller','whatsapp_qr','whatsapp_cloud') AND n->>'status' <> 'disabled' AND n->>'connectionStatus' <> 'DISCONNECTED')::int,0)
           - COALESCE((o->>'type' IN ('whatsapp_seller','whatsapp_qr','whatsapp_cloud') AND o->>'status' <> 'disabled' AND o->>'connectionStatus' <> 'DISCONNECTED')::int,0);
  ELSIF TG_TABLE_NAME = 'Inquiry' AND TG_OP = 'INSERT' THEN
    counter_key := 'MONTHLY_LEADS'; delta := 1;
  END IF;
  IF counter_key IS NOT NULL THEN
    next_value := GREATEST(0, COALESCE((u."countersJson"->>counter_key)::bigint,0) + delta);
    IF TG_TABLE_NAME = 'Integration' THEN
      SELECT count(*) INTO next_value FROM "Integration" WHERE "tenantId" = tid
        AND type IN ('whatsapp_seller','whatsapp_qr','whatsapp_cloud') AND status <> 'disabled' AND "connectionStatus" <> 'DISCONNECTED';
    END IF;
    cap := (u."limitsJson"->>counter_key)::numeric;
    IF delta > 0 AND cap >= 0 AND next_value > cap THEN
      RAISE EXCEPTION 'BASQAR_LIMIT:%', counter_key;
    END IF;
    u."countersJson" := jsonb_set(u."countersJson", ARRAY[counter_key], to_jsonb(next_value));
  END IF;
  bytes_delta := COALESCE(octet_length(n::text),0) - COALESCE(octet_length(o::text),0);
  -- Closing/reducing a resource and service bookkeeping must remain possible at capacity.
  cap := (u."limitsJson"->>'DATABASE_MB')::numeric;
  IF bytes_delta > 0 AND delta >= 0 AND cap >= 0 AND
     u."databaseBytes" + bytes_delta > cap * 1048576 AND
     TG_TABLE_NAME NOT IN ('Activity','InquiryStatusHistory','DealStageHistory','MessageStatusEvent','ContactPermission','Integration')
     AND NOT (TG_TABLE_NAME = 'Task' AND TG_OP = 'UPDATE' AND
       (n - ARRAY['status','completedAt','updatedAt']) = (o - ARRAY['status','completedAt','updatedAt'])) THEN
    RAISE EXCEPTION 'BASQAR_LIMIT:DATABASE_MB';
  END IF;
  IF TG_TABLE_NAME = 'Attachment' THEN
    files_delta := CASE WHEN n->>'parentType' LIKE 'support%' THEN 0 ELSE COALESCE((n->>'sizeBytes')::bigint,0) END
                 - CASE WHEN o->>'parentType' LIKE 'support%' THEN 0 ELSE COALESCE((o->>'sizeBytes')::bigint,0) END;
    cap := (u."limitsJson"->>'FILE_STORAGE_MB')::numeric;
    IF files_delta > 0 AND cap >= 0 AND u."fileBytes" + files_delta > cap * 1048576 THEN
      RAISE EXCEPTION 'BASQAR_LIMIT:FILE_STORAGE_MB';
    END IF;
  END IF;
  UPDATE "TenantUsage" SET "countersJson" = u."countersJson", period = u.period,
    "databaseBytes" = GREATEST(0, u."databaseBytes" + bytes_delta),
    "fileBytes" = GREATEST(0, u."fileBytes" + files_delta),
    "lastActivityAt" = CASE WHEN TG_TABLE_NAME IN ('Contact','Company','Inquiry','Deal','Task','Note','Message') THEN CURRENT_TIMESTAMP ELSE "lastActivityAt" END
    WHERE "tenantId" = tid;
  RETURN NULL;
END $$;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastInboundMessageId" TEXT;
