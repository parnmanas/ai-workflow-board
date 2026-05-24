-- Cleanup api_keys bloat.
--
-- Run scripts/diagnose-api-keys.sql FIRST to see what will be deleted.
--
-- Keep:
--   - is_active = 1 AND last_used_at within 7 days (currently in use)
--   - is_active = 1 AND last_used_at IS NULL AND created_at within 24h
--     (grace period for keys just minted by operator setup flows)
--
-- Delete:
--   - is_active = 0 (revoked — explicitly turned off, no longer wanted)
--   - is_active = 1 AND last_used_at IS NULL AND created_at < 24h ago
--     (created but never used — abandoned setup)
--   - is_active = 1 AND last_used_at < 7 days ago (stale — nothing
--     has authenticated with it in a week)
--
-- The 7-day window covers a worst-case operator vacation; if a key
-- hasn't authenticated in a week it's almost certainly orphaned by a
-- broken manager / re-pairing / superseded provisioning.
--
-- Run on production:
--   docker exec -i awb-postgres psql -U <user> -d <db> \
--     < scripts/cleanup-api-keys.sql

BEGIN;

-- Snapshot the count being deleted, log it for the audit trail.
DO $$
DECLARE
  doomed INT;
  kept   INT;
BEGIN
  SELECT COUNT(*) INTO doomed
    FROM api_keys
   WHERE is_active = 0
      OR (is_active = 1
          AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '7 days')
          AND (last_used_at IS NOT NULL OR created_at < NOW() - INTERVAL '24 hours'));

  SELECT COUNT(*) INTO kept
    FROM api_keys
   WHERE NOT (
           is_active = 0
        OR (is_active = 1
            AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '7 days')
            AND (last_used_at IS NOT NULL OR created_at < NOW() - INTERVAL '24 hours'))
         );

  RAISE NOTICE 'api_keys cleanup: about to delete %, keeping %', doomed, kept;
END $$;

-- Surface every doomed row so the psql log carries an audit trail.
SELECT
  id,
  name,
  is_active,
  agent_id,
  last_used_at,
  created_at
  FROM api_keys
 WHERE is_active = 0
    OR (is_active = 1
        AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '7 days')
        AND (last_used_at IS NOT NULL OR created_at < NOW() - INTERVAL '24 hours'))
 ORDER BY created_at DESC;

-- Delete.
DELETE FROM api_keys
 WHERE is_active = 0
    OR (is_active = 1
        AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '7 days')
        AND (last_used_at IS NOT NULL OR created_at < NOW() - INTERVAL '24 hours'));

-- Verify result.
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining FROM api_keys;
  RAISE NOTICE 'api_keys cleanup: % rows remain', remaining;
END $$;

COMMIT;
