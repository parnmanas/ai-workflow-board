-- Cleanup orphan rows where workspace_id IS NULL on tables whose entity
-- declares workspace_id NOT NULL.
--
-- Symptom this fixes — boot fails with:
--   QueryFailedError: column "workspace_id" of relation "<table>" contains
--   null values
-- when TypeORM synchronize tries to apply SET NOT NULL. These rows were
-- inserted during a prior schema window where workspace_id was tolerated as
-- nullable; they are corrupt by the current entity contract and every read
-- path filters by workspace_id so they are already invisible in the UI.
--
-- Sibling tables included (all declare workspace_id NOT NULL in their
-- entity decorators; see apps/server/src/entities/):
--   chat_rooms              (ChatRoom)
--   chat_room_messages      (ChatRoomMessage)
--   chat_room_participants  (ChatRoomParticipant)
--   user_mentions           (UserMention)
--   workspace_roles         (WorkspaceRole)
--   credentials             (Credential)
--   resources               (Resource)
--
-- Each cleanup is gated by an existence check so the script is safe to
-- re-run after a partial recovery; the transaction is atomic so any
-- per-table failure rolls the whole batch back.
--
-- Run on production BEFORE redeploying:
--   docker exec -i awb-postgres psql -U <user> -d <db> \
--     < scripts/cleanup-null-workspace-id-rows.sql
--
-- After running, re-run scripts/diagnose-chat-rooms-null-workspace.sql to
-- confirm every "null_count" is 0, then trigger the deploy.

BEGIN;

-- ─── chat_rooms ────────────────────────────────────────────────────────
-- Special handling: a room with messages or participants is NOT a pure
-- orphan; deleting it would orphan those dependents (entities use plain
-- FK columns, no ON DELETE CASCADE). For such rows we ABORT the whole
-- transaction with a diagnostic, so the operator can decide whether to
-- backfill workspace_id or delete the dependents first.
DO $$
DECLARE
  bad_rooms INT;
  orphan_rooms INT;
BEGIN
  SELECT COUNT(*) INTO bad_rooms
    FROM chat_rooms cr
   WHERE cr.workspace_id IS NULL
     AND (EXISTS (SELECT 1 FROM chat_room_messages m WHERE m.room_id = cr.id)
       OR EXISTS (SELECT 1 FROM chat_room_participants p WHERE p.room_id = cr.id));

  IF bad_rooms > 0 THEN
    RAISE EXCEPTION
      'Refusing to auto-delete %s chat_rooms with NULL workspace_id that '
      'have messages or participants. Run scripts/diagnose-chat-rooms-null-workspace.sql '
      'and decide whether to backfill workspace_id or delete the dependents first.',
      bad_rooms;
  END IF;

  SELECT COUNT(*) INTO orphan_rooms FROM chat_rooms WHERE workspace_id IS NULL;
  RAISE NOTICE 'chat_rooms: deleting % orphan rooms (no messages / no participants)', orphan_rooms;
END $$;

DELETE FROM chat_rooms WHERE workspace_id IS NULL;

-- ─── chat_room_messages ────────────────────────────────────────────────
-- Already corrupt (room reference may be stale; workspace filtering hides
-- them from every UI). Blanket delete is safe.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM chat_room_messages WHERE workspace_id IS NULL;
  RAISE NOTICE 'chat_room_messages: deleting % rows with NULL workspace_id', n;
END $$;
DELETE FROM chat_room_messages WHERE workspace_id IS NULL;

-- ─── chat_room_participants ────────────────────────────────────────────
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM chat_room_participants WHERE workspace_id IS NULL;
  RAISE NOTICE 'chat_room_participants: deleting % rows with NULL workspace_id', n;
END $$;
DELETE FROM chat_room_participants WHERE workspace_id IS NULL;

-- ─── user_mentions ─────────────────────────────────────────────────────
-- Same rationale as scripts/cleanup-user-mentions-empty-workspace.sql
-- (now removed from the tree after the main-sync, but the precedent
-- applies): mentions without workspace_id never surface in any inbox.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM user_mentions WHERE workspace_id IS NULL;
  RAISE NOTICE 'user_mentions: deleting % rows with NULL workspace_id', n;
END $$;
DELETE FROM user_mentions WHERE workspace_id IS NULL;

-- ─── workspace_roles ───────────────────────────────────────────────────
-- A role with no workspace can never be granted to a user in any
-- workspace context; orphan.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM workspace_roles WHERE workspace_id IS NULL;
  RAISE NOTICE 'workspace_roles: deleting % rows with NULL workspace_id', n;
END $$;
DELETE FROM workspace_roles WHERE workspace_id IS NULL;

-- ─── credentials ───────────────────────────────────────────────────────
-- Credentials are workspace-scoped secrets; rows without a workspace are
-- unreachable from every credential picker.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM credentials WHERE workspace_id IS NULL;
  RAISE NOTICE 'credentials: deleting % rows with NULL workspace_id', n;
END $$;
DELETE FROM credentials WHERE workspace_id IS NULL;

-- ─── resources ─────────────────────────────────────────────────────────
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM resources WHERE workspace_id IS NULL;
  RAISE NOTICE 'resources: deleting % rows with NULL workspace_id', n;
END $$;
DELETE FROM resources WHERE workspace_id IS NULL;

-- ─── Verify nothing slipped through ────────────────────────────────────
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT (
    (SELECT COUNT(*) FROM chat_rooms              WHERE workspace_id IS NULL) +
    (SELECT COUNT(*) FROM chat_room_messages      WHERE workspace_id IS NULL) +
    (SELECT COUNT(*) FROM chat_room_participants  WHERE workspace_id IS NULL) +
    (SELECT COUNT(*) FROM user_mentions           WHERE workspace_id IS NULL) +
    (SELECT COUNT(*) FROM workspace_roles         WHERE workspace_id IS NULL) +
    (SELECT COUNT(*) FROM credentials             WHERE workspace_id IS NULL) +
    (SELECT COUNT(*) FROM resources               WHERE workspace_id IS NULL)
  ) INTO remaining;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'Cleanup failed: % NULL workspace_id rows still remain', remaining;
  END IF;
  RAISE NOTICE 'Cleanup verified: 0 NULL workspace_id rows remain across all target tables.';
END $$;

COMMIT;
