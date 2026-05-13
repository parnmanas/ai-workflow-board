-- Cleanup script for the Phase B uuid pre-sync blocker on user_mentions.
--
-- Background — `user_mentions.workspace_id` is declared `@Column({ type:
-- 'uuid' })` (NOT NULL) in apps/server/src/entities/UserMention.ts, but
-- production has a small number of legacy rows with empty string left over
-- from when the v1 schema defaulted the column to ''. Pre-sync's safety
-- check refuses to convert these to uuid and aborts the boot
-- (see apps/server/src/database/pre-sync-postgres.ts:258).
--
-- These rows are notification artifacts. Without a workspace_id they are
-- already broken — every read path that surfaces mentions filters by
-- `workspace_id = $current_workspace`, so they appear in nobody's inbox
-- and never produce a badge. Deleting them loses no functional state.
--
-- Run on production BEFORE redeploying:
--
--   docker exec -i awb-postgres psql -U <user> -d <db> \
--     < scripts/cleanup-user-mentions-empty-workspace.sql
--
-- After running, re-run scripts/diagnose-presync-uuid.sql to confirm the
-- "CLEAN — no blockers" line, then trigger a deploy.

BEGIN;

-- 1. Show the rows we're about to delete (logged via NOTICE so it shows up
--    in psql output and is captured if you tee the session).
DO $$
DECLARE
  r RECORD;
  cnt INT := 0;
BEGIN
  FOR r IN
    SELECT id, source_type, source_id, actor_id, actor_name, preview, created_at
      FROM user_mentions
     WHERE workspace_id = ''
     ORDER BY created_at
  LOOP
    cnt := cnt + 1;
    RAISE NOTICE 'Will delete: id=% source=%/% actor=% (%) created=% preview=%',
      r.id, r.source_type, r.source_id, r.actor_name, r.actor_id,
      r.created_at, left(r.preview, 60);
  END LOOP;
  RAISE NOTICE 'Total rows to delete: %', cnt;
END $$;

-- 2. Delete.
DELETE FROM user_mentions WHERE workspace_id = '';

-- 3. Verify none remain. Aborts the transaction if any survived (defensive
--    — `workspace_id = ''` is the only filter, so this should be 0).
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining FROM user_mentions WHERE workspace_id = '';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Cleanup failed: % rows still have empty workspace_id', remaining;
  END IF;
  RAISE NOTICE 'Cleanup verified: 0 rows with empty workspace_id remain.';
END $$;

COMMIT;
