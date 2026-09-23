-- Run with psql against the intended environment before rollout. Read-only.
-- Do not run db:seed against a working installation.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT version() AS postgres_version;
SELECT p.code, p.version, tp.status, count(*) AS subscriptions,
       count(*) FILTER (WHERE tp."featuresSnapshotJson" = '{}'::jsonb) AS missing_feature_snapshot,
       count(*) FILTER (WHERE tp."limitsSnapshotJson" = '{}'::jsonb) AS missing_limit_snapshot
FROM "TenantPlan" tp JOIN "Plan" p ON p.id = tp."planId"
GROUP BY p.code, p.version, tp.status ORDER BY p.code, tp.status;

SELECT t.id, t.name, t.status AS tenant_status, t."createdAt",
       p.code AS plan_code, tp.status AS subscription_status,
       tp."amountMinor", tp."endsAt",
       (SELECT count(*) FROM "Membership" m WHERE m."tenantId"=t.id AND m.active) AS active_users,
       (SELECT count(*) FROM "Contact" c WHERE c."tenantId"=t.id) AS clients,
       (SELECT count(*) FROM "Deal" d WHERE d."tenantId"=t.id AND d.outcome='open' AND d."closedAt" IS NULL) AS active_deals,
       (SELECT coalesce(sum(a."sizeBytes"),0) FROM "Attachment" a WHERE a."tenantId"=t.id AND a."parentType" NOT LIKE 'support%') AS recorded_file_bytes
FROM "Tenant" t
LEFT JOIN LATERAL (SELECT * FROM "TenantPlan" x WHERE x."tenantId"=t.id ORDER BY x."startsAt" DESC LIMIT 1) tp ON true
LEFT JOIN "Plan" p ON p.id=tp."planId"
ORDER BY t."createdAt";

SELECT status, count(*) FROM "SubscriptionRequest" GROUP BY status ORDER BY status;
SELECT key, "valueJson" FROM "PlatformSetting" WHERE key='billing.freePolicy';
ROLLBACK;
