-- Diagnostic for the chat_rooms.workspace_id NULL blocker.
--
-- Symptom — production boot fails with:
--   QueryFailedError: column "workspace_id" of relation "chat_rooms"
--   contains null values
-- when TypeORM synchronize tries to apply SET NOT NULL (entity declares
-- workspace_id NOT NULL; pre-sync widens varchar -> uuid but does NOT
-- scrub orphan NULL rows for nullable:false target columns).
--
-- This script is READ-ONLY. It surfaces:
--   1. How many chat_rooms have NULL workspace_id.
--   2. Each NULL room's id, type, name, ticket_id, action_id, timestamps.
--   3. Whether each NULL room has any participants / messages (i.e. is it
--      a live room with data we'd lose, or a pure orphan we can delete).
--   4. The same NULL situation on the sibling tables (chat_room_messages
--      / chat_room_participants / user_mentions) so a follow-up cleanup
--      handles all of them in one pass.
--
-- Usage:
--   docker exec -i awb-postgres psql -U <user> -d <db> \
--     < scripts/diagnose-chat-rooms-null-workspace.sql

\echo '=== 1. Count of chat_rooms with NULL workspace_id ==='
SELECT COUNT(*) AS null_workspace_room_count
  FROM chat_rooms
 WHERE workspace_id IS NULL;

\echo ''
\echo '=== 2. Per-row detail of NULL workspace_id chat_rooms ==='
SELECT id, type, name, ticket_id, action_id, last_message_at, created_at
  FROM chat_rooms
 WHERE workspace_id IS NULL
 ORDER BY created_at;

\echo ''
\echo '=== 3. Participant + message counts for each NULL room ==='
SELECT cr.id AS room_id,
       cr.type,
       cr.created_at,
       COALESCE(p.participant_count, 0) AS participant_count,
       COALESCE(m.message_count, 0)     AS message_count
  FROM chat_rooms cr
  LEFT JOIN (
        SELECT room_id, COUNT(*) AS participant_count
          FROM chat_room_participants
         GROUP BY room_id
       ) p ON p.room_id = cr.id
  LEFT JOIN (
        SELECT room_id, COUNT(*) AS message_count
          FROM chat_room_messages
         GROUP BY room_id
       ) m ON m.room_id = cr.id
 WHERE cr.workspace_id IS NULL
 ORDER BY cr.created_at;

\echo ''
\echo '=== 4. Sibling tables — same NULL workspace_id blocker likely ==='
SELECT 'chat_room_messages'      AS table_name, COUNT(*) AS null_count FROM chat_room_messages      WHERE workspace_id IS NULL
UNION ALL
SELECT 'chat_room_participants'  AS table_name, COUNT(*) AS null_count FROM chat_room_participants  WHERE workspace_id IS NULL
UNION ALL
SELECT 'user_mentions'           AS table_name, COUNT(*) AS null_count FROM user_mentions           WHERE workspace_id IS NULL
UNION ALL
SELECT 'workspace_roles'         AS table_name, COUNT(*) AS null_count FROM workspace_roles         WHERE workspace_id IS NULL
UNION ALL
SELECT 'credentials'             AS table_name, COUNT(*) AS null_count FROM credentials             WHERE workspace_id IS NULL
UNION ALL
SELECT 'resources'               AS table_name, COUNT(*) AS null_count FROM resources               WHERE workspace_id IS NULL;
