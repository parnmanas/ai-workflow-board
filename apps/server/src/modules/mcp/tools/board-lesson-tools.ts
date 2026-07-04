/**
 * Board Lessons / Runbook MCP tools (ticket 9d0d6ac4).
 *
 * Tools: add_board_lesson, list_board_lessons, update_board_lesson
 *
 * A "lesson" is a short imperative runbook note captured from a past incident.
 * Active lessons for a board are auto-appended onto every dispatch prompt for
 * that board (TriggerLoopService._emitTrigger), so the next subagent sees the
 * lesson instead of re-learning it. These tools are the write/read surface for
 * agents (e.g. a self-improvement retrospective registering a recurrence-
 * prevention lesson) and mirror the REST endpoints under /api/boards/:id/lessons.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Board } from '../../../entities/Board';
import { BoardLesson } from '../../../entities/BoardLesson';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import {
  validateBoardLessonInput,
  validateBoardLessonUpdate,
  parseLessonTags,
  serializeLessonTags,
  MAX_LESSON_TITLE_LEN,
  MAX_LESSON_BODY_LEN,
} from '../../../common/board-lessons';
import type { ToolContext } from './context';

/** Shape a stored row for tool output: decode tags to an array. */
function projectLesson(row: BoardLesson) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    board_id: row.board_id,
    title: row.title,
    body: row.body,
    tags: parseLessonTags(row.tags),
    source_ticket_id: row.source_ticket_id,
    active: row.active,
    hit_count: row.hit_count,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerBoardLessonTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'add_board_lesson',
    `Register a board-scoped Lesson/Runbook entry — a short imperative note learned from a past incident that should be surfaced to EVERY future subagent on this board. Active lessons are auto-appended onto the board's dispatch prompts (ticket/QA/security), so the next strand does not repeat the mistake. Keep it tight and imperative (title ≤ ${MAX_LESSON_TITLE_LEN} chars, body ≤ ${MAX_LESSON_BODY_LEN} chars) — over-long input is rejected and a too-large total is truncated at inject time.`,
    {
      board_id: z.string().describe('Board the lesson belongs to'),
      title: z.string().describe('Short headline (e.g. "worktree node_modules 부재")'),
      body: z.string().describe('The imperative runbook — what to do / avoid. This lands in the prompt.'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Free-form tags (build/QA/git/env…). Metadata only in v1 — tag→context matching is v2.'),
      source_ticket_id: z
        .string()
        .optional()
        .describe('Ticket the lesson was learned on (deep-linked in the UI).'),
    },
    async ({ board_id, title, body, tags, source_ticket_id }, extra: { sessionId?: string }) => {
      const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err(`Board not found: ${board_id}`);

      const checked = validateBoardLessonInput({ title, body, tags, source_ticket_id });
      if (!checked.ok) return err(checked.error);

      const caller = getCallerAgent(extra);
      const repo = dataSource.getRepository(BoardLesson);
      const row = repo.create({
        workspace_id: board.workspace_id ?? null,
        board_id,
        title: checked.value.title,
        body: checked.value.body,
        tags: serializeLessonTags(checked.value.tags),
        source_ticket_id: checked.value.source_ticket_id || null,
        active: true,
        hit_count: 0,
        created_by: caller?.agentName || 'agent',
      });
      const saved = await repo.save(row);
      return ok(projectLesson(saved));
    },
  );

  server.tool(
    'list_board_lessons',
    'List a board\'s Lessons/Runbook entries. Active-only by default; pass include_inactive=true to also see deactivated ones. Ordered most-recently-updated first (the same order the injector uses).',
    {
      board_id: z.string().describe('Board to list lessons for'),
      include_inactive: z
        .boolean()
        .optional()
        .describe('Include deactivated lessons (default false).'),
    },
    async ({ board_id, include_inactive }) => {
      const where: any = { board_id };
      if (!include_inactive) where.active = true;
      const rows = await dataSource.getRepository(BoardLesson).find({
        where,
        order: { updated_at: 'DESC' },
      });
      return ok(rows.map(projectLesson));
    },
  );

  server.tool(
    'update_board_lesson',
    'Update a board lesson. Pass any subset of fields; set active=false to DEACTIVATE it (stops injection, retained for audit) or active=true to re-enable. Same length caps as add_board_lesson.',
    {
      lesson_id: z.string().describe('Lesson id to update'),
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      source_ticket_id: z.string().optional(),
      active: z.boolean().optional().describe('false = deactivate (no longer injected); true = re-enable.'),
    },
    async ({ lesson_id, title, body, tags, source_ticket_id, active }) => {
      const repo = dataSource.getRepository(BoardLesson);
      const row = await repo.findOne({ where: { id: lesson_id } });
      if (!row) return err(`Lesson not found: ${lesson_id}`);

      // Only validate the fields actually supplied.
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (body !== undefined) patch.body = body;
      if (tags !== undefined) patch.tags = tags;
      if (source_ticket_id !== undefined) patch.source_ticket_id = source_ticket_id;
      if (active !== undefined) patch.active = active;
      const checked = validateBoardLessonUpdate(patch);
      if (!checked.ok) return err(checked.error);

      const v = checked.value;
      if (v.title !== undefined) row.title = v.title;
      if (v.body !== undefined) row.body = v.body;
      if (v.tags !== undefined) row.tags = serializeLessonTags(v.tags);
      if (v.source_ticket_id !== undefined) row.source_ticket_id = v.source_ticket_id || null;
      if (v.active !== undefined) row.active = v.active;

      const saved = await repo.save(row);
      return ok(projectLesson(saved));
    },
  );
}
