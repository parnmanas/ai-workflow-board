-- Diagnostic for api_keys bloat.
--
-- Background: every pairing redemption creates a new api_key, every
-- managed-agent provisioning creates+revokes another, and revoked
-- rows are NEVER deleted from the table. After multiple manager
-- restarts / re-pairings / managed-agent spawns the table accumulates
-- dozens of inactive rows.
--
-- This script is READ-ONLY. Shows:
--   1. Total counts by status.
--   2. Per-row breakdown with the categorisation the cleanup script uses.
--   3. The pairing / provisioning name-prefix breakdown so the operator
--      can spot the dominant source of bloat.
--
-- Usage:
--   docker exec -i awb-postgres psql -U <user> -d <db> \
--     < scripts/diagnose-api-keys.sql

\echo '=== 1. Totals ==='
SELECT
  COUNT(*)                                                          AS total_keys,
  COUNT(*) FILTER (WHERE is_active = 1)                             AS active,
  COUNT(*) FILTER (WHERE is_active = 0)                             AS revoked,
  COUNT(*) FILTER (WHERE last_used_at IS NULL)                      AS never_used,
  COUNT(*) FILTER (WHERE last_used_at >= NOW() - INTERVAL '7 days') AS used_within_7d,
  COUNT(*) FILTER (WHERE created_at  >= NOW() - INTERVAL '24 hours') AS created_within_24h
  FROM api_keys;

\echo ''
\echo '=== 2. Per-row breakdown (newest first) ==='
SELECT
  id,
  CASE
    WHEN name LIKE 'agent-manager-provisioned:%' THEN 'managed-agent-provisioned'
    WHEN name LIKE 'agent-manager:%'             THEN 'manager-pairing'
    ELSE                                              'human-or-other'
  END                                  AS source,
  name,
  is_active,
  agent_id,
  last_used_at,
  created_at,
  CASE
    WHEN is_active = 1 AND last_used_at >= NOW() - INTERVAL '7 days'           THEN 'KEEP (recent use)'
    WHEN is_active = 1 AND last_used_at IS NULL
         AND created_at >= NOW() - INTERVAL '24 hours'                         THEN 'KEEP (grace 24h)'
    WHEN is_active = 0                                                         THEN 'DELETE (revoked)'
    WHEN is_active = 1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '7 days')
                                                                               THEN 'DELETE (stale)'
    ELSE                                                                            'KEEP (other)'
  END                                  AS verdict
  FROM api_keys
 ORDER BY created_at DESC;

\echo ''
\echo '=== 3. Source breakdown ==='
SELECT
  CASE
    WHEN name LIKE 'agent-manager-provisioned:%' THEN 'managed-agent-provisioned'
    WHEN name LIKE 'agent-manager:%'             THEN 'manager-pairing'
    ELSE                                              'human-or-other'
  END                                                AS source,
  COUNT(*)                                           AS total,
  COUNT(*) FILTER (WHERE is_active = 1)              AS active,
  COUNT(*) FILTER (WHERE is_active = 0)              AS revoked
  FROM api_keys
 GROUP BY 1
 ORDER BY 2 DESC;
