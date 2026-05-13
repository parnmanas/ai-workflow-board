-- Diagnose which rows in production will block pre-sync-postgres uuid widening.
--
-- Scans every (table, column) target from apps/server/src/database/pre-sync-postgres.ts
-- and reports any rows whose value isn't a valid uuid. Reports both empty
-- strings (the v1 default) and any other garbage (sentinels, slugs, truncated
-- ids). Read-only — no UPDATE / DELETE here.
--
-- Run on the production DB:
--
--   docker exec -i awb-postgres psql -U "$DB_USER" -d "$DB_NAME" \
--     < scripts/diagnose-presync-uuid.sql
--
-- Or, if running from the repo on the NAS:
--   cat scripts/diagnose-presync-uuid.sql | docker exec -i awb-postgres \
--     psql -U <user> -d <db>
--
-- Output: NOTICE lines listing every (table, column) with bad rows, the empty-
-- string count, and the non-uuid (non-empty) count.

DO $$
DECLARE
  r          RECORD;
  cnt_empty  BIGINT;
  cnt_bad    BIGINT;
  cnt_total  BIGINT;
  is_nullbl  BOOLEAN;
  any_bad    BOOLEAN := FALSE;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Phase A
      ('ticket_role_assignments', 'ticket_id'),
      ('ticket_role_assignments', 'role_id'),
      ('tickets',                 'column_id'),
      ('columns',                 'board_id'),
      -- Phase B: workspace_id
      ('tickets',              'workspace_id'),
      ('comments',             'workspace_id'),
      ('activity_logs',        'workspace_id'),
      ('ticket_attachments',   'workspace_id'),
      ('api_keys',             'workspace_id'),
      ('ticket_read_state',    'workspace_id'),
      ('columns',              'workspace_id'),
      ('channels',             'workspace_id'),
      ('agent_error_logs',     'workspace_id'),
      ('boards',               'workspace_id'),
      ('agents',               'workspace_id'),
      ('prompt_templates',     'workspace_id'),
      ('workspace_roles',      'workspace_id'),
      ('chat_rooms',           'workspace_id'),
      ('chat_room_messages',   'workspace_id'),
      ('user_mentions',        'workspace_id'),
      ('credentials',          'workspace_id'),
      ('resources',            'workspace_id'),
      ('actions',              'workspace_id'),
      ('action_runs',          'workspace_id'),
      ('subagents',            'workspace_id'),
      -- Phase B: ticket / column / board FK
      ('comments',           'ticket_id'),
      ('ticket_attachments', 'ticket_id'),
      ('ticket_read_state',  'ticket_id'),
      ('tickets',            'parent_id'),
      ('tickets',            'next_ticket_id'),
      ('comments',           'parent_id'),
      ('chat_rooms',         'ticket_id'),
      ('user_mentions',      'ticket_id'),
      ('subagents',          'ticket_id'),
      ('actions',            'board_id'),
      -- Phase B: user / agent / resource / credential FK
      ('tickets',                 'assignee_id'),
      ('tickets',                 'reporter_id'),
      ('tickets',                 'reviewer_id'),
      ('tickets',                 'locked_by_agent_id'),
      ('tickets',                 'base_repo_resource_id'),
      ('tickets',                 'created_by_id'),
      ('comments',                'author_id'),
      ('ticket_attachments',      'uploaded_by_id'),
      ('ticket_read_state',       'user_id'),
      ('users',                   'requested_workspace_id'),
      ('user_channels',           'user_id'),
      ('user_mentions',           'user_id'),
      ('user_mentions',           'source_id'),
      ('user_mentions',           'actor_id'),
      ('user_mentions',           'room_id'),
      ('ticket_role_assignments', 'agent_id'),
      ('ticket_role_assignments', 'user_id'),
      ('agents',                  'parent_agent_id'),
      ('agents',                  'manager_agent_id'),
      ('agents',                  'credential_id'),
      ('api_keys',                'agent_id'),
      ('resources',               'board_id'),
      ('resources',               'credential_id'),
      ('resource_embeddings',     'resource_id'),
      ('subagents',               'agent_id'),
      ('agent_error_logs',        'agent_id'),
      ('chat_rooms',              'action_id'),
      ('chat_room_participants',  'room_id'),
      ('chat_room_participants',  'participant_id'),
      ('chat_room_messages',      'room_id'),
      ('chat_room_messages',      'sender_id'),
      ('actions',                 'target_agent_id'),
      ('action_runs',             'action_id'),
      ('action_runs',             'room_id'),
      ('action_runs',             'triggered_by_id')
    ) AS t(table_name, column_name)
  LOOP
    -- Skip targets where the column is missing OR already widened to uuid
    -- (so this script keeps working after the migration finishes).
    SELECT (is_nullable = 'YES')
      INTO is_nullbl
      FROM information_schema.columns
     WHERE table_name = r.table_name
       AND column_name = r.column_name
       AND data_type = 'character varying';
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT COUNT(*) FROM %I WHERE %I = ''''',
      r.table_name, r.column_name
    ) INTO cnt_empty;

    EXECUTE format(
      $q$SELECT COUNT(*) FROM %I
          WHERE %I IS NOT NULL
            AND %I <> ''
            AND %I !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'$q$,
      r.table_name, r.column_name, r.column_name, r.column_name
    ) INTO cnt_bad;

    EXECUTE format('SELECT COUNT(*) FROM %I', r.table_name) INTO cnt_total;

    -- For nullable columns, '' is auto-scrubbed by pre-sync (UPDATE ... = NULL),
    -- so it's NOT a blocker. Only flag '' on NOT NULL columns or non-empty
    -- garbage anywhere.
    IF (cnt_empty > 0 AND NOT is_nullbl) OR cnt_bad > 0 THEN
      any_bad := TRUE;
      RAISE NOTICE '  % . %  (nullable=%, total=%):  empty=%  non_uuid_garbage=%',
        rpad(r.table_name, 26),
        rpad(r.column_name, 24),
        is_nullbl,
        cnt_total,
        cnt_empty,
        cnt_bad;
    END IF;
  END LOOP;

  IF NOT any_bad THEN
    RAISE NOTICE 'CLEAN — no blockers. Pre-sync should complete.';
  ELSE
    RAISE NOTICE '----';
    RAISE NOTICE 'For each row above:';
    RAISE NOTICE '  - empty>0 on NOT NULL  → must DELETE the row OR backfill workspace_id';
    RAISE NOTICE '  - non_uuid_garbage>0   → must DELETE / fix the row';
    RAISE NOTICE 'Use SELECT to inspect specific rows before deleting, e.g.:';
    RAISE NOTICE '  SELECT id, * FROM user_mentions WHERE workspace_id = '''';';
  END IF;
END $$;
