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

-- IMPORTANT: the third VALUES column is the *target* nullability after
-- pre-sync runs (mirrors COLUMNS_TO_UUID's `nullable` field). Do NOT use the
-- production DB's current is_nullable — pre-sync DROPs NOT NULL itself for
-- target=true columns, so '' on a currently-NOT-NULL/target-nullable column
-- is auto-scrubbed and is NOT a blocker. Only target=false columns abort.
DO $$
DECLARE
  r          RECORD;
  cnt_empty  BIGINT;
  cnt_bad    BIGINT;
  cnt_total  BIGINT;
  any_bad    BOOLEAN := FALSE;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Phase A
      ('ticket_role_assignments', 'ticket_id',  FALSE),
      ('ticket_role_assignments', 'role_id',    FALSE),
      ('tickets',                 'column_id',  TRUE ),
      ('columns',                 'board_id',   FALSE),
      -- Phase B: workspace_id
      ('tickets',              'workspace_id', TRUE ),
      ('comments',             'workspace_id', TRUE ),
      ('activity_logs',        'workspace_id', TRUE ),
      ('ticket_attachments',   'workspace_id', TRUE ),
      ('api_keys',             'workspace_id', TRUE ),
      ('ticket_read_state',    'workspace_id', TRUE ),
      ('columns',              'workspace_id', TRUE ),
      ('channels',             'workspace_id', TRUE ),
      ('agent_error_logs',     'workspace_id', TRUE ),
      ('boards',               'workspace_id', TRUE ),
      ('agents',               'workspace_id', TRUE ),
      ('prompt_templates',     'workspace_id', TRUE ),
      ('workspace_roles',      'workspace_id', FALSE),
      ('chat_rooms',           'workspace_id', FALSE),
      ('chat_room_messages',   'workspace_id', FALSE),
      ('user_mentions',        'workspace_id', FALSE),
      ('credentials',          'workspace_id', FALSE),
      ('resources',            'workspace_id', FALSE),
      ('actions',              'workspace_id', FALSE),
      ('action_runs',          'workspace_id', FALSE),
      ('subagents',            'workspace_id', FALSE),
      -- Phase B: ticket / column / board FK
      ('comments',           'ticket_id',     FALSE),
      ('ticket_attachments', 'ticket_id',     FALSE),
      ('ticket_read_state',  'ticket_id',     FALSE),
      ('tickets',            'parent_id',     TRUE ),
      ('tickets',            'next_ticket_id', TRUE),
      ('comments',           'parent_id',     TRUE ),
      ('chat_rooms',         'ticket_id',     TRUE ),
      ('user_mentions',      'ticket_id',     TRUE ),
      ('subagents',          'ticket_id',     TRUE ),
      ('actions',            'board_id',      TRUE ),
      -- Phase B: user / agent / resource / credential FK
      ('tickets',                 'assignee_id',           TRUE ),
      ('tickets',                 'reporter_id',           TRUE ),
      ('tickets',                 'reviewer_id',           TRUE ),
      ('tickets',                 'locked_by_agent_id',    TRUE ),
      ('tickets',                 'base_repo_resource_id', TRUE ),
      ('tickets',                 'created_by_id',         TRUE ),
      ('comments',                'author_id',             TRUE ),
      ('ticket_attachments',      'uploaded_by_id',        TRUE ),
      ('ticket_read_state',       'user_id',               FALSE),
      ('users',                   'requested_workspace_id', TRUE),
      ('user_channels',           'user_id',               FALSE),
      ('user_mentions',           'user_id',               FALSE),
      ('user_mentions',           'source_id',             FALSE),
      ('user_mentions',           'actor_id',              FALSE),
      ('user_mentions',           'room_id',               TRUE ),
      ('ticket_role_assignments', 'agent_id',              TRUE ),
      ('ticket_role_assignments', 'user_id',               TRUE ),
      ('agents',                  'parent_agent_id',       TRUE ),
      ('agents',                  'manager_agent_id',      TRUE ),
      ('agents',                  'credential_id',         TRUE ),
      ('api_keys',                'agent_id',              TRUE ),
      ('resources',               'board_id',              TRUE ),
      ('resources',               'credential_id',         TRUE ),
      ('resource_embeddings',     'resource_id',           FALSE),
      ('subagents',               'agent_id',              FALSE),
      ('agent_error_logs',        'agent_id',              FALSE),
      ('chat_rooms',              'action_id',             TRUE ),
      ('chat_room_participants',  'room_id',               FALSE),
      ('chat_room_participants',  'participant_id',        FALSE),
      ('chat_room_messages',      'room_id',               FALSE),
      ('chat_room_messages',      'sender_id',             FALSE),
      ('actions',                 'target_agent_id',       FALSE),
      ('action_runs',             'action_id',             FALSE),
      ('action_runs',             'room_id',               FALSE),
      ('action_runs',             'triggered_by_id',       TRUE )
    ) AS t(table_name, column_name, target_nullable)
  LOOP
    -- Skip targets where the column is missing OR already widened to uuid
    -- (so this script keeps working after the migration finishes).
    PERFORM 1
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

    -- target_nullable=TRUE  → '' is auto-scrubbed by pre-sync (UPDATE ... = NULL)
    --                         so empty rows are NOT a blocker. Garbage still is.
    -- target_nullable=FALSE → empty rows ARE a blocker (pre-sync aborts).
    IF (cnt_empty > 0 AND NOT r.target_nullable) OR cnt_bad > 0 THEN
      any_bad := TRUE;
      RAISE NOTICE '  % . %  (target_nullable=%, total=%):  empty=%  non_uuid_garbage=%',
        rpad(r.table_name, 26),
        rpad(r.column_name, 24),
        r.target_nullable,
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
    RAISE NOTICE '  - empty>0 on target_nullable=f  → must DELETE the row OR backfill the column';
    RAISE NOTICE '  - non_uuid_garbage>0            → must DELETE / fix the row';
    RAISE NOTICE 'Use SELECT to inspect specific rows before deleting, e.g.:';
    RAISE NOTICE '  SELECT id, * FROM user_mentions WHERE workspace_id = '''';';
  END IF;
END $$;
