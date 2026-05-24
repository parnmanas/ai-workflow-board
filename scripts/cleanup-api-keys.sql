-- Aggressive cleanup — keep at most 1 apiKey per agent_id.
--
-- Run scripts/diagnose-api-keys.sql FIRST to see what will be deleted.
--
-- KEEP per agent_id: the single most-recently-used active row.
--   Tiebreaker order:
--     1. is_active = 1 ranks ahead of is_active = 0
--     2. last_used_at DESC (NULLs last)
--     3. created_at DESC
--   So we always keep the live key the agent is actually authenticating
--   with right now. Inactive / older duplicates go.
--
-- KEEP all human-created keys:
--   Any name NOT matching the auto-prefixes (agent-manager:* or
--   agent-manager-provisioned:*) is treated as operator-created and
--   preserved regardless of usage / agent linkage. These show up in the
--   "API Keys" admin page and should not be silently nuked.
--
-- DELETE:
--   - Auto-prefix keys with NULL agent_id (orphans from ON DELETE SET NULL)
--   - Auto-prefix keys that lost the per-agent-id "keepers" tiebreaker
--     (duplicates from re-pairings, manual rotations, recreated cli-homes)
--
-- Run on production:
--   docker exec -i awb-postgres psql -U <user> -d <db> \
--     < scripts/cleanup-api-keys.sql

BEGIN;

-- 1. Build the set of rows we plan to keep.
CREATE TEMP TABLE keepers AS
WITH per_agent AS (
  -- Per-agent winner — one row per agent_id, ranked by:
  --   1. active first
  --   2. most recently used
  --   3. newest created
  SELECT DISTINCT ON (agent_id) id
    FROM api_keys
   WHERE agent_id IS NOT NULL
   ORDER BY
     agent_id,
     CASE WHEN is_active = 1 THEN 0 ELSE 1 END,
     last_used_at DESC NULLS LAST,
     created_at DESC
)
SELECT id FROM per_agent
UNION
-- Human-created keys (preserved as-is, even when agent_id is NULL).
SELECT id FROM api_keys
 WHERE name NOT LIKE 'agent-manager:%'
   AND name NOT LIKE 'agent-manager-provisioned:%';

-- 2. Show counts and the about-to-delete rows for the audit log.
DO $$
DECLARE
  doomed INT;
  kept   INT;
BEGIN
  SELECT COUNT(*) INTO kept   FROM api_keys WHERE id IN (SELECT id FROM keepers);
  SELECT COUNT(*) INTO doomed FROM api_keys WHERE id NOT IN (SELECT id FROM keepers);
  RAISE NOTICE 'api_keys cleanup: keeping %, deleting %', kept, doomed;
END $$;

\echo ''
\echo '=== Rows to delete (sample, newest first) ==='
SELECT
  id,
  name,
  agent_id,
  is_active,
  last_used_at,
  created_at
  FROM api_keys
 WHERE id NOT IN (SELECT id FROM keepers)
 ORDER BY created_at DESC
 LIMIT 50;

-- 3. Delete.
DELETE FROM api_keys
 WHERE id NOT IN (SELECT id FROM keepers);

-- 4. Verify result — final per-agent row count should be ≤ 1.
\echo ''
\echo '=== Per-agent row counts after cleanup ==='
SELECT agent_id, COUNT(*) AS rows
  FROM api_keys
 WHERE agent_id IS NOT NULL
 GROUP BY agent_id
 ORDER BY rows DESC, agent_id
 LIMIT 20;

DO $$
DECLARE
  total INT;
  duplicates INT;
BEGIN
  SELECT COUNT(*) INTO total FROM api_keys;
  SELECT COUNT(*) INTO duplicates
    FROM (
      SELECT agent_id FROM api_keys
       WHERE agent_id IS NOT NULL
       GROUP BY agent_id HAVING COUNT(*) > 1
    ) t;
  RAISE NOTICE 'api_keys cleanup: % rows remain, % agents still have duplicates', total, duplicates;
END $$;

COMMIT;
