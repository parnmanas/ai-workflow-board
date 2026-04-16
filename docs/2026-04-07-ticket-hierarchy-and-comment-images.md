# Ticket Hierarchy & Comment Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Subtask entity with a self-referencing Ticket hierarchy (parent_id + depth) and add image attachment support (base64 BLOB) to Comments.

**Architecture:** Ticket gains `parent_id` (nullable self-ref FK) and `depth` (0=root, 1=subtask, 2=sub-subtask). Board queries filter `parent_id IS NULL`. Comment gains `images` field storing JSON array of base64-encoded image objects. Frontend gets a Jira-style slide panel for subtask detail.

**Tech Stack:** NestJS 11, TypeORM 0.3 (sqljs, synchronize:true), React 18, TypeScript

---

## File Structure

### Backend — Modified
- `apps/server/src/entities/Ticket.ts` — add parent_id, depth, parent/children relations
- `apps/server/src/entities/Comment.ts` — add images field
- `apps/server/src/modules/tickets/tickets.controller.ts` — add children endpoint, update loadTicketFull, update board-related queries
- `apps/server/src/modules/tickets/tickets.module.ts` — no Subtask import needed anymore
- `apps/server/src/modules/boards/boards.controller.ts` — filter parent_id IS NULL in board GET
- `apps/server/src/modules/agent-api/agent-api.controller.ts` — replace Subtask with child Ticket
- `apps/server/src/modules/agent-api/agent-api.module.ts` — remove Subtask import
- `apps/server/src/modules/mcp/mcp-tools.ts` — replace Subtask with child Ticket
- `apps/server/src/services/activity.service.ts` — update LogActivityParams type
- `apps/server/src/database/database.module.ts` — remove Subtask from entities
- `apps/server/src/app.module.ts` — remove SubtasksModule

### Backend — Deleted
- `apps/server/src/entities/Subtask.ts`
- `apps/server/src/modules/subtasks/subtasks.controller.ts`
- `apps/server/src/modules/subtasks/subtasks.module.ts`

### Frontend — Modified
- `apps/client/src/types.ts` — remove Subtask, update Ticket/Comment types
- `apps/client/src/api.ts` — replace subtask API with children API, update addComment
- `apps/client/src/hooks/useBoard.ts` — replace subtask methods with child ticket methods
- `apps/client/src/components/Board.tsx` — update handler signatures
- `apps/client/src/components/TicketCard.tsx` — use children for progress
- `apps/client/src/components/TicketDetail.tsx` — use ChildTicketList, add comment image UI
- `apps/client/src/components/SubtaskList.tsx` — rewrite as ChildTicketList

### Frontend — Created
- `apps/client/src/components/SubtaskPanel.tsx` — slide-in panel for subtask detail

---

### Task 1: Update Ticket Entity — Add parent_id, depth, self-referencing relations

**Files:**
- Modify: `apps/server/src/entities/Ticket.ts`

- [ ] **Step 1: Add parent_id, depth columns and self-referencing relations to Ticket entity**

Open `apps/server/src/entities/Ticket.ts`. Replace the entire file with:

```typescript
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BoardColumn } from './BoardColumn';
import { Comment } from './Comment';

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  column_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  parent_id: string | null;

  @Column({ type: 'int', default: 0 })
  depth: number;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: 'medium' })
  priority: string;

  @Column({ type: 'varchar', default: '' })
  assignee: string;

  @Column({ type: 'varchar', default: '' })
  reporter: string;

  @Column({ type: 'varchar', default: '' })
  assignee_id: string;

  @Column({ type: 'varchar', default: '' })
  reporter_id: string;

  @Column({ type: 'varchar', default: '[]' })
  labels: string;

  @Column({ type: 'varchar', default: '[]' })
  channel_ids: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'varchar', default: 'todo' })
  status: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => BoardColumn, col => col.tickets, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'column_id' })
  column: BoardColumn;

  @ManyToOne(() => Ticket, ticket => ticket.children, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Ticket | null;

  @OneToMany(() => Ticket, ticket => ticket.parent, { cascade: true })
  children: Ticket[];

  @OneToMany(() => Comment, comment => comment.ticket, { cascade: true })
  comments: Comment[];
}
```

Key changes:
- `column_id` is now `nullable: true` (subtasks have no column)
- Added `parent_id` (nullable, self-ref FK)
- Added `depth` (0=root, 1=subtask, 2=sub-subtask)
- Added `status` field (todo/in_progress/done) — previously only on Subtask, now needed for all tickets
- Replaced `subtasks` relation with self-referencing `parent`/`children`

- [ ] **Step 2: Verify the server compiles (may have import errors — those will be fixed in subsequent tasks)**

Run: `cd ai-workflow-board && npx turbo build --filter=server 2>&1 | head -30`

Expected: Compilation errors referencing Subtask — this is fine, we'll fix them in the following tasks.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/entities/Ticket.ts
git commit -m "feat: add parent_id, depth, status and self-referencing relations to Ticket entity"
```

---

### Task 2: Update Comment Entity — Add images field

**Files:**
- Modify: `apps/server/src/entities/Comment.ts`

- [ ] **Step 1: Add images column to Comment entity**

Open `apps/server/src/entities/Comment.ts`. Replace the entire file with:

```typescript
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Ticket } from './Ticket';

@Entity('comments')
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar', default: 'user' })
  author_type: string;

  @Column({ type: 'varchar', default: '' })
  author_id: string;

  @Column({ type: 'varchar' })
  author: string;

  @Column({ type: 'varchar' })
  content: string;

  @Column({ type: 'text', default: '[]' })
  images: string;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Ticket, ticket => ticket.comments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/entities/Comment.ts
git commit -m "feat: add images field to Comment entity for base64 image storage"
```

---

### Task 3: Remove Subtask Entity, Module, and all Subtask references from shared modules

**Files:**
- Delete: `apps/server/src/entities/Subtask.ts`
- Delete: `apps/server/src/modules/subtasks/subtasks.controller.ts`
- Delete: `apps/server/src/modules/subtasks/subtasks.module.ts`
- Modify: `apps/server/src/app.module.ts`
- Modify: `apps/server/src/database/database.module.ts`
- Modify: `apps/server/src/services/activity.service.ts`

- [ ] **Step 1: Delete Subtask entity and module files**

```bash
rm apps/server/src/entities/Subtask.ts
rm -rf apps/server/src/modules/subtasks
```

- [ ] **Step 2: Remove SubtasksModule from app.module.ts**

In `apps/server/src/app.module.ts`, remove the SubtasksModule import line:
```typescript
// DELETE: import { SubtasksModule } from './modules/subtasks/subtasks.module';
```
And remove `SubtasksModule` from the `imports` array.

The file should look like:

```typescript
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { BoardsModule } from './modules/boards/boards.module';
import { ColumnsModule } from './modules/columns/columns.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { UsersModule } from './modules/users/users.module';
import { AgentsModule } from './modules/agents/agents.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { ActivityModule } from './modules/activity/activity.module';
import { AgentApiModule } from './modules/agent-api/agent-api.module';
import { QaModule } from './modules/qa/qa.module';
import { HealthModule } from './modules/health/health.module';
import { McpModule } from './modules/mcp/mcp.module';
import { AdminModule } from './modules/admin/admin.module';
import { SharedServicesModule } from './services/shared-services.module';

@Module({
  imports: [
    DatabaseModule,
    SharedServicesModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'client', 'dist'),
      exclude: ['/api{*path}', '/mcp{*path}'],
    }),
    AuthModule,
    WorkspacesModule,
    BoardsModule,
    ColumnsModule,
    TicketsModule,
    UsersModule,
    AgentsModule,
    ChannelsModule,
    ApiKeysModule,
    ActivityModule,
    AgentApiModule,
    QaModule,
    HealthModule,
    McpModule,
    AdminModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 3: Remove Subtask from database.module.ts entities array**

In `apps/server/src/database/database.module.ts`:
- Remove the import: `import { Subtask } from '../entities/Subtask';`
- Remove `Subtask` from the `entities` array

The entities line becomes:
```typescript
const entities = [Workspace, Board, BoardColumn, Ticket, Comment, User, Agent, AgentChannelIdentity, Channel, ActivityLog, ApiKey];
```

- [ ] **Step 4: Update activity.service.ts — remove 'subtask' from entity_type**

In `apps/server/src/services/activity.service.ts`, change the `LogActivityParams` interface:

```typescript
export interface LogActivityParams {
  entity_type: 'ticket' | 'comment';
  entity_id: string | number;
  action: 'created' | 'updated' | 'moved' | 'deleted' | 'status_changed';
  field_changed?: string;
  old_value?: string;
  new_value?: string;
  actor_id?: string;
  actor_name?: string;
  ticket_id: string;
}
```

(Just removed `'subtask'` from the entity_type union.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove Subtask entity, module, and all shared references"
```

---

### Task 4: Update Tickets Controller — Children endpoint, board filter, comment images

**Files:**
- Modify: `apps/server/src/modules/tickets/tickets.controller.ts`
- Modify: `apps/server/src/modules/tickets/tickets.module.ts`

- [ ] **Step 1: Rewrite tickets.controller.ts**

Replace `apps/server/src/modules/tickets/tickets.controller.ts` with:

```typescript
import { Controller, Get, Post, Patch, Delete, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ActivityService } from '../../services/activity.service';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_IMAGES_PER_COMMENT = 5;

function parseTicket(ticket: Ticket) {
  return {
    ...ticket,
    labels: JSON.parse(ticket.labels || '[]'),
    channel_ids: JSON.parse(ticket.channel_ids || '[]'),
    children: (ticket.children || [])
      .sort((a, b) => a.position - b.position)
      .map(child => ({
        ...child,
        labels: JSON.parse(child.labels || '[]'),
        channel_ids: JSON.parse(child.channel_ids || '[]'),
        children: (child.children || []).sort((a, b) => a.position - b.position).map(gc => ({
          ...gc,
          labels: JSON.parse(gc.labels || '[]'),
          channel_ids: JSON.parse(gc.channel_ids || '[]'),
          children: [],
          comments: (gc.comments || []).sort((a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          ),
        })),
        comments: (child.comments || []).sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ),
      })),
    comments: (ticket.comments || []).sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    ),
  };
}

async function loadTicketFull(ticketRepo: Repository<Ticket>, id: string) {
  const ticket = await ticketRepo.findOne({
    where: { id },
    relations: [
      'children', 'children.children', 'children.children.comments',
      'children.comments', 'comments',
    ],
  });
  if (!ticket) return null;
  return parseTicket(ticket);
}

@Controller('api')
@UseGuards(AuthGuard)
export class TicketsController {
  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  /** Resolve agent ID from name if ID is missing */
  private async resolveAgentId(id: string, name: string): Promise<string> {
    if (id) return id;
    if (!name) return '';
    const agent = await this.agentRepo.findOne({ where: { name } }).catch(() => null);
    return agent?.id || '';
  }

  @Post('columns/:columnId/tickets')
  async create(@Param('columnId') columnId: string, @Body() body: any, @Res() res: Response) {
    const { title, description = '', priority = 'medium', assignee = '', reporter = '', assignee_id = '', reporter_id = '', labels = [], channel_ids = [] } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const col = await this.colRepo.findOne({ where: { id: columnId } });
    if (!col) return res.status(404).json({ error: 'Column not found' });

    const resolvedAssigneeId = await this.resolveAgentId(assignee_id, assignee);
    const resolvedReporterId = await this.resolveAgentId(reporter_id, reporter);

    const maxResult = await this.ticketRepo
      .createQueryBuilder('t')
      .select('COALESCE(MAX(t.position), -1)', 'max')
      .where('t.column_id = :columnId AND t.parent_id IS NULL', { columnId })
      .getRawOne();

    const position = (maxResult?.max ?? -1) + 1;
    const ticket = await this.ticketRepo.save(this.ticketRepo.create({
      column_id: columnId, title, description, priority, assignee, reporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids),
      position, parent_id: null, depth: 0, status: 'todo',
    }));

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'created',
      ticket_id: ticket.id, actor_name: reporter || assignee,
    });

    return res.status(201).json({ ...ticket, labels, channel_ids, children: [], comments: [] });
  }

  @Post('tickets/:parentId/children')
  async createChild(@Param('parentId') parentId: string, @Body() body: any, @Res() res: Response) {
    const parent = await this.ticketRepo.findOne({ where: { id: parentId } });
    if (!parent) return res.status(404).json({ error: 'Parent ticket not found' });

    const childDepth = parent.depth + 1;
    if (childDepth > 2) return res.status(400).json({ error: 'Maximum depth of 2 exceeded' });

    const { title, description = '', priority = 'medium', status = 'todo', assignee = '', reporter = '', assignee_id = '', reporter_id = '', labels = [], channel_ids = [] } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const resolvedAssigneeId = await this.resolveAgentId(assignee_id, assignee);
    const resolvedReporterId = await this.resolveAgentId(reporter_id, reporter);

    const maxResult = await this.ticketRepo
      .createQueryBuilder('t')
      .select('COALESCE(MAX(t.position), -1)', 'max')
      .where('t.parent_id = :parentId', { parentId })
      .getRawOne();

    const position = (maxResult?.max ?? -1) + 1;
    const child = await this.ticketRepo.save(this.ticketRepo.create({
      parent_id: parentId, depth: childDepth, column_id: null as any,
      title, description, priority, status, assignee, reporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids), position,
    }));

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: child.id, action: 'created',
      ticket_id: parent.depth === 0 ? parentId : parent.parent_id || parentId,
      actor_name: reporter || assignee,
      new_value: title,
    });

    return res.status(201).json({ ...child, labels: JSON.parse(child.labels || '[]'), channel_ids: JSON.parse(child.channel_ids || '[]'), children: [], comments: [] });
  }

  @Get('tickets/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const ticket = await loadTicketFull(this.ticketRepo, id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(ticket);
  }

  @Patch('tickets/:id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { title, description, priority, assignee, reporter, assignee_id, reporter_id, labels, channel_ids, status } = body;
    const oldAssignee = ticket.assignee;
    const oldReporter = ticket.reporter;
    const oldStatus = ticket.status;

    if (title !== undefined) ticket.title = title;
    if (description !== undefined) ticket.description = description;
    if (priority !== undefined) ticket.priority = priority;
    if (status !== undefined) ticket.status = status;
    if (assignee !== undefined) {
      ticket.assignee = assignee;
      ticket.assignee_id = await this.resolveAgentId(assignee_id || '', assignee);
    } else if (assignee_id !== undefined) {
      ticket.assignee_id = assignee_id;
    }
    if (reporter !== undefined) {
      ticket.reporter = reporter;
      ticket.reporter_id = await this.resolveAgentId(reporter_id || '', reporter);
    } else if (reporter_id !== undefined) {
      ticket.reporter_id = reporter_id;
    }
    if (labels !== undefined) ticket.labels = JSON.stringify(labels);
    if (channel_ids !== undefined) ticket.channel_ids = JSON.stringify(channel_ids);

    await this.ticketRepo.save(ticket);

    // Activity logging
    if (status !== undefined && status !== oldStatus) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'status_changed',
        field_changed: 'status', old_value: oldStatus || '', new_value: status,
        ticket_id: ticket.parent_id || ticket.id,
      });
    }
    if (assignee !== undefined && assignee !== oldAssignee) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'assignee', old_value: oldAssignee || '', new_value: assignee || '',
        ticket_id: ticket.parent_id || ticket.id,
      });
    }
    if (reporter !== undefined && reporter !== oldReporter) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'reporter', old_value: oldReporter || '', new_value: reporter || '',
        ticket_id: ticket.parent_id || ticket.id,
      });
    }

    const changes = [];
    if (title !== undefined) changes.push('title');
    if (description !== undefined) changes.push('description');
    if (priority !== undefined) changes.push('priority');
    const otherChanges = changes.filter(c => !['assignee', 'reporter', 'status'].includes(c));
    if (otherChanges.length > 0) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: otherChanges.join(', '),
        ticket_id: ticket.parent_id || ticket.id,
      });
    }

    const updated = await loadTicketFull(this.ticketRepo, ticket.id);
    return res.json(updated);
  }

  @Patch('tickets/:id/move')
  async move(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { targetColumnId, targetPosition } = body;
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Only root tickets can be moved on the board
    if (ticket.depth > 0) return res.status(400).json({ error: 'Only root tickets can be moved on the board' });

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const sourceColumnId = ticket.column_id;

      await tRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('column_id = :colId AND position > :pos AND parent_id IS NULL', { colId: sourceColumnId, pos: ticket.position })
        .execute();

      const destColumnId = targetColumnId || sourceColumnId;
      const destCount = await tRepo.createQueryBuilder('t')
        .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: destColumnId, id: ticket.id })
        .getCount();
      const pos = Math.min(targetPosition ?? destCount, destCount);

      await tRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position + 1' })
        .where('column_id = :colId AND position >= :pos AND id != :id AND parent_id IS NULL', { colId: destColumnId, pos, id: ticket.id })
        .execute();

      await tRepo.update(ticket.id, { column_id: destColumnId, position: pos });
    });

    const updated = await loadTicketFull(this.ticketRepo, ticket.id);

    const oldCol = await this.colRepo.findOne({ where: { id: ticket.column_id } });
    const newColId = targetColumnId || ticket.column_id;
    const newCol = await this.colRepo.findOne({ where: { id: newColId } });

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
      field_changed: 'column', old_value: oldCol?.name || String(ticket.column_id),
      new_value: newCol?.name || String(newColId), ticket_id: ticket.id,
    });

    return res.json(updated);
  }

  @Delete('tickets/:id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const ticket = await this.ticketRepo.findOne({
      where: { id },
      relations: ['children', 'comments'],
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const columnId = ticket.column_id;
    const position = ticket.position;
    const parentId = ticket.parent_id;

    await this.ticketRepo.remove(ticket);

    if (parentId) {
      // Re-index sibling children positions
      await this.ticketRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('parent_id = :parentId AND position > :pos', { parentId, pos: position })
        .execute();
    } else if (columnId) {
      // Re-index column ticket positions
      await this.ticketRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('column_id = :colId AND position > :pos AND parent_id IS NULL', { colId: columnId, pos: position })
        .execute();
    }

    return res.json({ success: true });
  }

  @Post('tickets/:id/comments')
  async addComment(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { content, images = [] } = body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Validate images
    if (images.length > MAX_IMAGES_PER_COMMENT) {
      return res.status(400).json({ error: `Maximum ${MAX_IMAGES_PER_COMMENT} images per comment` });
    }
    for (const img of images) {
      if (!img.data || !img.filename || !img.mimetype) {
        return res.status(400).json({ error: 'Each image must have data, filename, and mimetype' });
      }
      // Rough base64 size check: base64 is ~4/3 of original
      const approxSize = (img.data.length * 3) / 4;
      if (approxSize > MAX_IMAGE_SIZE) {
        return res.status(400).json({ error: `Image ${img.filename} exceeds ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit` });
      }
    }

    const comment = await this.commentRepo.save(this.commentRepo.create({
      ticket_id: id,
      author_type: 'user',
      author_id: currentUser.id,
      author: currentUser.name,
      content,
      images: JSON.stringify(images),
    }));

    return res.status(201).json({ ...comment, images: JSON.parse(comment.images || '[]') });
  }
}
```

- [ ] **Step 2: Update tickets.module.ts — remove Subtask references**

Replace `apps/server/src/modules/tickets/tickets.module.ts` with:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { TicketsController } from './tickets.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket, BoardColumn, Comment, Agent])],
  controllers: [TicketsController],
  providers: [AuthGuard],
})
export class TicketsModule {}
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/modules/tickets/
git commit -m "feat: add children endpoint, comment images, depth validation to tickets controller"
```

---

### Task 5: Update Boards Controller — Filter parent_id IS NULL

**Files:**
- Modify: `apps/server/src/modules/boards/boards.controller.ts`

- [ ] **Step 1: Update board GET to filter only root tickets and load children**

In `apps/server/src/modules/boards/boards.controller.ts`, update the `get` method. Find the ticket query inside the `get` method (around line 49-67) and replace it:

Change:
```typescript
        const tickets = await this.ticketRepo.find({
          where: { column_id: col.id },
          relations: ['subtasks', 'comments'],
          order: { position: 'ASC' },
        });
        return {
          ...col,
          tickets: tickets.map(t => ({
            ...t,
            labels: JSON.parse(t.labels || '[]'),
            subtasks: (t.subtasks || []).sort((a, b) => a.position - b.position),
            comments: (t.comments || []).sort((a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            ),
          })),
        };
```

To:
```typescript
        const tickets = await this.ticketRepo.find({
          where: { column_id: col.id, parent_id: IsNull() },
          relations: ['children', 'children.children', 'comments'],
          order: { position: 'ASC' },
        });
        return {
          ...col,
          tickets: tickets.map(t => ({
            ...t,
            labels: JSON.parse(t.labels || '[]'),
            channel_ids: JSON.parse(t.channel_ids || '[]'),
            children: (t.children || []).sort((a, b) => a.position - b.position).map(child => ({
              ...child,
              labels: JSON.parse(child.labels || '[]'),
              channel_ids: JSON.parse(child.channel_ids || '[]'),
              children: (child.children || []).sort((a, b) => a.position - b.position),
            })),
            comments: (t.comments || []).sort((a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            ),
          })),
        };
```

Also add `IsNull` to the typeorm import at the top:
```typescript
import { Repository, IsNull } from 'typeorm';
```

And remove the unused `Subtask` import if present (it's not in the current file, but verify).

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/modules/boards/boards.controller.ts
git commit -m "feat: filter board to show only root tickets, load children hierarchy"
```

---

### Task 6: Update Agent API Controller — Replace Subtask with child Ticket

**Files:**
- Modify: `apps/server/src/modules/agent-api/agent-api.controller.ts`
- Modify: `apps/server/src/modules/agent-api/agent-api.module.ts`

- [ ] **Step 1: Read and update agent-api.controller.ts**

Read the full file first, then make these changes:
1. Remove all `import { Subtask }` references
2. Remove `@InjectRepository(Subtask) private readonly subtaskRepo: Repository<Subtask>` from constructor
3. Replace `relations: ['subtasks']` with `relations: ['children']`
4. Replace subtask progress calculation: `t.subtasks` → `t.children`, `s.done` → `s.status === 'done'`
5. In create ticket: replace Subtask creation with child Ticket creation
6. In batch operations: replace `add-subtask` with child ticket creation via ticketRepo, replace `update-subtask` with ticket update via ticketRepo

Key replacements:
- `const sRepo = manager.getRepository(Subtask)` → `const tRepo = manager.getRepository(Ticket)` (for child creation)
- Subtask creation becomes: `tRepo.save(tRepo.create({ parent_id: ticketId, depth: 1, title: stTitle, position: idx, status: 'todo', column_id: null }))`
- `case 'add-subtask'` operations use ticketRepo instead of subtaskRepo
- `case 'update-subtask'` operations use ticketRepo with string ID

- [ ] **Step 2: Update agent-api.module.ts — remove Subtask**

Remove `import { Subtask }` and remove `Subtask` from `TypeOrmModule.forFeature([...])`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/modules/agent-api/
git commit -m "refactor: replace Subtask with child Ticket in agent API"
```

---

### Task 7: Update MCP Tools — Replace Subtask with child Ticket

**Files:**
- Modify: `apps/server/src/modules/mcp/mcp-tools.ts`

- [ ] **Step 1: Read and update mcp-tools.ts**

This file has extensive Subtask usage. Key changes:
1. Remove `import { Subtask }` 
2. Remove `maxSubtaskPosition` helper — replace with a query on Ticket where parent_id = ticketId
3. Replace `relations: ['subtasks', 'comments']` → `relations: ['children', 'children.children', 'comments']`
4. Replace subtask progress: `t.subtasks` → `t.children`, `s.done` → `s.status === 'done'`
5. Replace `create_subtask` tool: create child Ticket instead
6. Replace `update_subtask` tool: update Ticket by UUID
7. Replace `delete_subtask` tool: delete Ticket by UUID
8. In `create_ticket`: replace inline subtask creation with child Ticket creation
9. In batch operations: replace `add-subtask`/`update-subtask` with child Ticket CRUD
10. Update descriptions mentioning "subtask" to "child ticket"

Key function replacement for `maxSubtaskPosition`:
```typescript
async function maxChildPosition(parentId: string): Promise<number> {
  const result = await AppDataSource.getRepository(Ticket)
    .createQueryBuilder('t')
    .select('COALESCE(MAX(t.position), -1)', 'max')
    .where('t.parent_id = :parentId', { parentId })
    .getRawOne();
  return (result?.max ?? -1) + 1;
}
```

Tool name changes:
- `create_subtask` → `create_child_ticket` (keep backward compat description mentioning subtask)
- `update_subtask` → `update_child_ticket`  
- `delete_subtask` → `delete_child_ticket`
- Parameter `subtask_id: z.number()` → `ticket_id: z.string()` (Ticket uses UUID, not number)
- `ticket_id` parameter in create → `parent_id`

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/modules/mcp/mcp-tools.ts
git commit -m "refactor: replace Subtask with child Ticket in MCP tools"
```

---

### Task 8: Frontend — Update types.ts

**Files:**
- Modify: `apps/client/src/types.ts`

- [ ] **Step 1: Update types**

In `apps/client/src/types.ts`:

1. Remove the `Subtask` interface entirely (lines 88-104)
2. Update `Comment` interface — add `images`:
```typescript
export interface CommentImage {
  filename: string;
  mimetype: string;
  data: string; // base64
}

export interface Comment {
  id: string;
  ticket_id: string;
  author_type: 'user' | 'agent' | 'system';
  author_id: string;
  author: string;
  content: string;
  images: CommentImage[];
  created_at: string;
}
```

3. Update `Ticket` interface — add parent_id, depth, status, children; remove subtasks:
```typescript
export interface Ticket {
  id: string;
  column_id: string | null;
  parent_id: string | null;
  depth: number;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: string;
  assignee: string;
  reporter: string;
  assignee_id: string;
  reporter_id: string;
  labels: string[];
  channel_ids: string[];
  position: number;
  children: Ticket[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/client/src/types.ts
git commit -m "feat: update frontend types — remove Subtask, add ticket hierarchy and comment images"
```

---

### Task 9: Frontend — Update api.ts

**Files:**
- Modify: `apps/client/src/api.ts`

- [ ] **Step 1: Replace subtask API methods with children API, update addComment**

In `apps/client/src/api.ts`:

Replace the Subtasks section:
```typescript
  // ─── Subtasks ──────────────────────────────────────────
  createSubtask: (ticketId: string, data: {
    title: string; description?: string; priority?: string; status?: string;
    assignee?: string; reporter?: string; assignee_id?: string; reporter_id?: string;
  }) =>
    request<any>(`/tickets/${ticketId}/subtasks`, { method: 'POST', body: JSON.stringify(data) }),

  updateSubtask: (id: number, data: Record<string, any>) =>
    request<any>(`/subtasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteSubtask: (id: number) =>
    request<any>(`/subtasks/${id}`, { method: 'DELETE' }),
```

With:
```typescript
  // ─── Child Tickets (Subtasks) ──────────────────────────
  createChildTicket: (parentId: string, data: {
    title: string; description?: string; priority?: string; status?: string;
    assignee?: string; reporter?: string; assignee_id?: string; reporter_id?: string;
    labels?: string[]; channel_ids?: string[];
  }) =>
    request<any>(`/tickets/${parentId}/children`, { method: 'POST', body: JSON.stringify(data) }),
```

Note: child tickets are updated/deleted using the same `updateTicket`/`deleteTicket` endpoints.

Update the Comments section:
```typescript
  // ─── Comments ──────────────────────────────────────────
  addComment: (ticketId: string, content: string, images: { filename: string; mimetype: string; data: string }[] = []) =>
    request<any>(`/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify({ content, images }) }),
```

- [ ] **Step 2: Commit**

```bash
git add apps/client/src/api.ts
git commit -m "feat: replace subtask API with child ticket API, add comment images support"
```

---

### Task 10: Frontend — Update useBoard hook

**Files:**
- Modify: `apps/client/src/hooks/useBoard.ts`

- [ ] **Step 1: Replace subtask methods with child ticket methods**

Replace the entire file content:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { Board, Workspace, User, Agent, Channel } from '../types';

export function useBoard(boardId: string = '') {
  const [board, setBoard] = useState<Board | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!boardId) {
      setBoard(null);
      setLoading(false);
      return;
    }
    try {
      const boardData = await api.getBoard(boardId);
      setBoard(boardData);
      setError(null);

      const [usersData, agentsData, channelsData] = await Promise.all([
        api.getUsers().catch(() => []),
        api.getAgents().catch(() => []),
        api.getChannels().catch(() => []),
      ]);
      setUsers(usersData);
      setAgents(agentsData);
      setChannels(channelsData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const createTicket = async (columnId: string, title: string, priority = 'medium') => {
    await api.createTicket(columnId, { title, priority });
    await refresh();
  };

  const updateTicket = async (ticketId: string, data: Record<string, any>) => {
    await api.updateTicket(ticketId, data);
    await refresh();
  };

  const moveTicket = async (ticketId: string, targetColumnId: string, targetPosition: number) => {
    const prevBoard = board;
    if (board) {
      setBoard(prev => {
        if (!prev) return prev;
        const cols = prev.columns.map(c => ({ ...c, tickets: [...c.tickets] }));
        const srcCol = cols.find(c => c.tickets.some(t => t.id === ticketId));
        const dstCol = cols.find(c => c.id === targetColumnId);
        if (!srcCol || !dstCol) return prev;
        const ticketIdx = srcCol.tickets.findIndex(t => t.id === ticketId);
        if (ticketIdx === -1) return prev;
        const [moved] = srcCol.tickets.splice(ticketIdx, 1);
        dstCol.tickets.splice(targetPosition, 0, moved);
        return { ...prev, columns: cols };
      });
    }

    try {
      await api.moveTicket(ticketId, targetColumnId, targetPosition);
      await refresh();
    } catch (err) {
      setBoard(prevBoard);
      throw err;
    }
  };

  const deleteTicket = async (ticketId: string) => {
    await api.deleteTicket(ticketId);
    await refresh();
  };

  const createChildTicket = async (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => {
    await api.createChildTicket(parentId, data);
    await refresh();
  };

  const addComment = async (ticketId: string, content: string, images: { filename: string; mimetype: string; data: string }[] = []) => {
    await api.addComment(ticketId, content, images);
    await refresh();
  };

  // Column management
  const createColumn = async (boardId: string, name: string, color?: string) => {
    await api.createColumn(boardId, { name, color });
    await refresh();
  };

  const updateColumn = async (columnId: string, data: { name?: string; color?: string; position?: number }) => {
    await api.updateColumn(columnId, data);
    await refresh();
  };

  const deleteColumn = async (columnId: string) => {
    await api.deleteColumn(columnId);
    await refresh();
  };

  return {
    board,
    users,
    agents,
    channels,
    loading,
    error,
    refresh,
    createTicket,
    updateTicket,
    moveTicket,
    deleteTicket,
    createChildTicket,
    addComment,
    createColumn,
    updateColumn,
    deleteColumn,
  };
}

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getWorkspaces();
      setWorkspaces(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createWorkspace = async (name: string, description = '') => {
    const ws = await api.createWorkspace({ name, description });
    await refresh();
    return ws;
  };

  const updateWorkspace = async (id: string, data: { name?: string; description?: string }) => {
    await api.updateWorkspace(id, data);
    await refresh();
  };

  const deleteWorkspace = async (id: string) => {
    await api.deleteWorkspace(id);
    await refresh();
  };

  return {
    workspaces,
    loading,
    error,
    refresh,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/client/src/hooks/useBoard.ts
git commit -m "feat: replace subtask methods with child ticket methods in useBoard hook"
```

---

### Task 11: Frontend — Update TicketCard to use children

**Files:**
- Modify: `apps/client/src/components/TicketCard.tsx`

- [ ] **Step 1: Update progress calculation to use children instead of subtasks**

In `apps/client/src/components/TicketCard.tsx`, replace:

```typescript
  const doneSubtasks = ticket.subtasks.filter(s => s.done).length;
  const totalSubtasks = ticket.subtasks.length;
  const progress = totalSubtasks > 0 ? (doneSubtasks / totalSubtasks) * 100 : 0;
```

With:

```typescript
  const doneChildren = (ticket.children || []).filter(c => c.status === 'done').length;
  const totalChildren = (ticket.children || []).length;
  const progress = totalChildren > 0 ? (doneChildren / totalChildren) * 100 : 0;
```

And update the template references — replace `totalSubtasks` → `totalChildren`, `doneSubtasks` → `doneChildren`:

```typescript
            {totalChildren > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                <div style={{
                  flex: 1,
                  height: 3,
                  background: '#334155',
                  borderRadius: 2,
                  maxWidth: 60,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${progress}%`,
                    background: progress === 100 ? '#34d399' : '#6366f1',
                    borderRadius: 2,
                  }} />
                </div>
                <span style={{ fontSize: '10px', color: '#64748b' }}>
                  {doneChildren}/{totalChildren}
                </span>
              </div>
            )}
```

- [ ] **Step 2: Commit**

```bash
git add apps/client/src/components/TicketCard.tsx
git commit -m "feat: update TicketCard to show children progress instead of subtasks"
```

---

### Task 12: Frontend — Rewrite SubtaskList as ChildTicketList

**Files:**
- Modify: `apps/client/src/components/SubtaskList.tsx` (rewrite in place)

- [ ] **Step 1: Rewrite SubtaskList.tsx as ChildTicketList**

Replace the entire file `apps/client/src/components/SubtaskList.tsx`:

```tsx
import React, { useState } from 'react';
import { Ticket, Agent } from '../types';

interface ChildTicketListProps {
  parentTicket: Ticket;
  agents: Agent[];
  maxDepth: number; // max allowed depth for this parent's children
  onCreateChild: (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => void;
  onUpdateChild: (childId: string, data: Record<string, any>) => void;
  onDeleteChild: (childId: string) => void;
  onSelectChild?: (child: Ticket) => void; // opens slide panel
}

const priorityColors: Record<string, string> = {
  low: '#94a3b8',
  medium: '#60a5fa',
  high: '#fbbf24',
  critical: '#ef4444',
};

const statusColors: Record<string, string> = {
  todo: '#94a3b8',
  in_progress: '#fbbf24',
  done: '#34d399',
};

export default function ChildTicketList({ parentTicket, agents, maxDepth, onCreateChild, onUpdateChild, onDeleteChild, onSelectChild }: ChildTicketListProps) {
  const children = parentTicket.children || [];
  const [newTitle, setNewTitle] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: '', description: '', priority: 'medium', assignee: '', reporter: '',
  });

  const doneCount = children.filter(c => c.status === 'done').length;
  const progress = children.length > 0 ? (doneCount / children.length) * 100 : 0;

  const inputStyle = {
    background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
    padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', outline: 'none', width: '100%',
  };

  const handleQuickCreate = () => {
    if (newTitle.trim()) {
      onCreateChild(parentTicket.id, { title: newTitle.trim() });
      setNewTitle('');
    }
  };

  const handleDetailedCreate = () => {
    if (createForm.title.trim()) {
      onCreateChild(parentTicket.id, createForm);
      setCreateForm({ title: '', description: '', priority: 'medium', assignee: '', reporter: '' });
      setShowCreateForm(false);
    }
  };

  const canCreateChildren = parentTicket.depth < maxDepth;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1' }}>
          Subtasks ({doneCount}/{children.length})
        </h4>
        {canCreateChildren && (
          <button onClick={() => setShowCreateForm(!showCreateForm)} style={{
            background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer',
            fontSize: '11px', fontWeight: 600,
          }}>{showCreateForm ? 'Simple' : 'Detailed'}</button>
        )}
      </div>

      {children.length > 0 && (
        <div style={{
          height: 4, background: '#334155', borderRadius: 2, marginBottom: 10, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${progress}%`,
            background: progress === 100 ? '#34d399' : '#6366f1',
            borderRadius: 2, transition: 'width 0.3s ease',
          }} />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children.map(child => (
          <div key={child.id} style={{
            borderRadius: 6, background: '#1e293b', border: '1px solid #334155', overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
              <input
                type="checkbox"
                checked={child.status === 'done'}
                onChange={() => onUpdateChild(child.id, { status: child.status === 'done' ? 'todo' : 'done' })}
                style={{ cursor: 'pointer', accentColor: '#6366f1' }}
              />
              <span style={{
                fontSize: '10px', fontWeight: 700, padding: '1px 4px', borderRadius: 3,
                color: priorityColors[child.priority || 'medium'],
                background: `${priorityColors[child.priority || 'medium']}15`,
              }}>{(child.priority || 'medium').slice(0, 3).toUpperCase()}</span>
              <span
                onClick={() => onSelectChild?.(child)}
                style={{
                  flex: 1, fontSize: '13px', cursor: onSelectChild ? 'pointer' : 'default',
                  color: child.status === 'done' ? '#64748b' : '#e2e8f0',
                  textDecoration: child.status === 'done' ? 'line-through' : 'none',
                }}
              >{child.title}</span>
              {(child.children || []).length > 0 && (
                <span style={{ fontSize: '10px', color: '#64748b', background: '#0f172a', padding: '2px 6px', borderRadius: 4 }}>
                  {(child.children || []).filter(gc => gc.status === 'done').length}/{(child.children || []).length}
                </span>
              )}
              <select
                value={child.status || 'todo'}
                onChange={e => {
                  e.stopPropagation();
                  onUpdateChild(child.id, { status: e.target.value });
                }}
                onClick={e => e.stopPropagation()}
                style={{
                  background: 'transparent', border: 'none', fontSize: '10px', fontWeight: 600,
                  color: statusColors[child.status || 'todo'], cursor: 'pointer', outline: 'none',
                }}
              >
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
              </select>
              {child.assignee && (
                <span style={{ fontSize: '10px', color: '#64748b', background: '#0f172a', padding: '2px 6px', borderRadius: 4 }}>
                  {child.assignee}
                </span>
              )}
              <button onClick={(e) => { e.stopPropagation(); onDeleteChild(child.id); }} style={{
                background: 'none', border: 'none', color: '#475569', cursor: 'pointer',
                fontSize: '14px', padding: '0 4px',
              }}>x</button>
            </div>
          </div>
        ))}
      </div>

      {/* Create form */}
      {canCreateChildren && (
        showCreateForm ? (
          <div style={{
            marginTop: 8, background: '#0f172a', borderRadius: 6, padding: 10,
            border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <input value={createForm.title} onChange={e => setCreateForm({ ...createForm, title: e.target.value })}
              placeholder="Subtask title..." style={inputStyle} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <select value={createForm.priority} onChange={e => setCreateForm({ ...createForm, priority: e.target.value })} style={inputStyle}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <select value={createForm.assignee} onChange={e => setCreateForm({ ...createForm, assignee: e.target.value })} style={inputStyle}>
                <option value="">Unassigned</option>
                {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select>
            </div>
            <textarea value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })}
              placeholder="Description..." rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCreateForm(false)} style={{
                background: 'transparent', color: '#94a3b8', border: '1px solid #334155',
                borderRadius: 6, padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
              }}>Cancel</button>
              <button onClick={handleDetailedCreate} style={{
                background: '#6366f1', color: 'white', border: 'none', borderRadius: 6,
                padding: '4px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              }}>Add Subtask</button>
            </div>
          </div>
        ) : (
          <form onSubmit={e => { e.preventDefault(); handleQuickCreate(); }} style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Add subtask..." style={{ ...inputStyle, flex: 1 }} />
            <button type="submit" style={{
              background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 6,
              padding: '6px 12px', fontSize: '12px', cursor: 'pointer',
            }}>+</button>
          </form>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/client/src/components/SubtaskList.tsx
git commit -m "feat: rewrite SubtaskList as ChildTicketList using ticket hierarchy"
```

---

### Task 13: Frontend — Create SubtaskPanel (Jira-style slide-in panel)

**Files:**
- Create: `apps/client/src/components/SubtaskPanel.tsx`

- [ ] **Step 1: Create SubtaskPanel component**

Create `apps/client/src/components/SubtaskPanel.tsx`:

```tsx
import React, { useState, useEffect } from 'react';
import { Ticket, Agent, Channel, ActivityLog } from '../types';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import ChildTicketList from './SubtaskList';

interface SubtaskPanelProps {
  ticket: Ticket;
  agents: Agent[];
  channels: Channel[];
  onClose: () => void;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
  onCreateChild: (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => void;
  onDeleteChild: (childId: string) => void;
  onAddComment: (ticketId: string, content: string, images?: { filename: string; mimetype: string; data: string }[]) => void;
}

const priorityColors: Record<string, string> = {
  low: '#94a3b8',
  medium: '#60a5fa',
  high: '#fbbf24',
  critical: '#ef4444',
};

const statusColors: Record<string, string> = {
  todo: '#94a3b8',
  in_progress: '#fbbf24',
  done: '#34d399',
};

export default function SubtaskPanel({
  ticket, agents, channels, onClose, onUpdate, onDelete,
  onCreateChild, onDeleteChild, onAddComment,
}: SubtaskPanelProps) {
  const { user } = useAuth();
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [priority, setPriority] = useState(ticket.priority);
  const [status, setStatus] = useState(ticket.status || 'todo');
  const resolveAgentName = (id: string | undefined, name: string) => {
    if (id) {
      const agent = agents.find(a => a.id === id);
      if (agent) return agent.name;
    }
    return name;
  };
  const [assignee, setAssignee] = useState(resolveAgentName(ticket.assignee_id, ticket.assignee));
  const [reporter, setReporter] = useState(resolveAgentName(ticket.reporter_id, ticket.reporter));
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>(ticket.channel_ids || []);
  const [commentContent, setCommentContent] = useState('');
  const [commentImages, setCommentImages] = useState<{ filename: string; mimetype: string; data: string }[]>([]);
  const [activeTab, setActiveTab] = useState<'detail' | 'activity'>('detail');
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description);
    setPriority(ticket.priority);
    setStatus(ticket.status || 'todo');
    setAssignee(resolveAgentName(ticket.assignee_id, ticket.assignee));
    setReporter(resolveAgentName(ticket.reporter_id, ticket.reporter));
    setSelectedChannelIds(ticket.channel_ids || []);
  }, [ticket.id, ticket.title, ticket.description, ticket.priority, ticket.assignee, ticket.reporter, ticket.status, ticket.updated_at]);

  useEffect(() => {
    if (activeTab === 'activity') {
      api.getTicketActivity(ticket.id).then(setActivities).catch(() => {});
    }
  }, [activeTab, ticket.id]);

  const saveField = (field: string, value: any) => {
    onUpdate(ticket.id, { [field]: value });
  };

  const handleImageAttach = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      const newImages: typeof commentImages = [];
      for (let i = 0; i < files.length && commentImages.length + newImages.length < 5; i++) {
        const file = files[i];
        if (file.size > 5 * 1024 * 1024) continue;
        const data = await fileToBase64(file);
        newImages.push({ filename: file.name, mimetype: file.type, data });
      }
      setCommentImages(prev => [...prev, ...newImages].slice(0, 5));
    };
    input.click();
  };

  const handleSubmitComment = () => {
    if (commentContent.trim()) {
      onAddComment(ticket.id, commentContent.trim(), commentImages.length > 0 ? commentImages : undefined);
      setCommentContent('');
      setCommentImages([]);
    }
  };

  const labelStyle = { fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' as const, display: 'block', marginBottom: 4 };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 560, maxWidth: '100vw',
      background: '#1e293b', borderLeft: '1px solid #334155', zIndex: 1100,
      display: 'flex', flexDirection: 'column',
      boxShadow: '-8px 0 30px rgba(0,0,0,0.4)',
      animation: 'slideInRight 0.2s ease-out',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid #334155',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onClose} style={{
            background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 6,
            padding: '4px 10px', fontSize: '14px', cursor: 'pointer',
          }}>←</button>
          <span style={{
            fontSize: '10px', padding: '2px 6px', borderRadius: 4,
            background: '#0f172a', color: '#94a3b8', fontWeight: 500,
          }}>#{ticket.id.slice(0, 8)}</span>
          <span style={{
            fontSize: '10px', padding: '2px 6px', borderRadius: 4,
            background: `${statusColors[status]}20`, color: statusColors[status], fontWeight: 600,
          }}>{status.replace('_', ' ').toUpperCase()}</span>
        </div>
        <button onClick={() => { onDelete(ticket.id); onClose(); }} style={{
          background: '#7f1d1d', color: '#fca5a5', border: 'none', borderRadius: 6,
          padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
        }}>Delete</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #334155', flexShrink: 0 }}>
        {(['detail', 'activity'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: '8px 16px', background: 'transparent', border: 'none',
            borderBottom: activeTab === tab ? '2px solid #6366f1' : '2px solid transparent',
            color: activeTab === tab ? '#e2e8f0' : '#64748b',
            fontSize: '12px', fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
          }}>{tab}</button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {activeTab === 'detail' ? (
          <>
            {/* Title */}
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={() => title !== ticket.title && saveField('title', title)}
              style={{
                width: '100%', background: 'transparent', border: 'none', color: '#f1f5f9',
                fontSize: '18px', fontWeight: 700, outline: 'none', marginBottom: 12,
              }}
            />

            {/* Meta */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Status</label>
                <select value={status} onChange={e => { setStatus(e.target.value); saveField('status', e.target.value); }}
                  style={{ background: '#0f172a', border: `2px solid ${statusColors[status]}`, borderRadius: 6, padding: '6px 10px', color: statusColors[status], fontSize: '12px', fontWeight: 600, width: '100%' }}>
                  <option value="todo">To Do</option>
                  <option value="in_progress">In Progress</option>
                  <option value="done">Done</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Priority</label>
                <select value={priority} onChange={e => { setPriority(e.target.value); saveField('priority', e.target.value); }}
                  style={{ background: '#0f172a', border: `2px solid ${priorityColors[priority]}`, borderRadius: 6, padding: '6px 10px', color: priorityColors[priority], fontSize: '12px', fontWeight: 600, width: '100%' }}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Assignee (AI)</label>
                <select value={assignee} onChange={e => {
                  const name = e.target.value;
                  const agent = agents.find(a => a.name === name);
                  setAssignee(name);
                  onUpdate(ticket.id, { assignee: name, assignee_id: agent?.id || '' });
                }} style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', width: '100%' }}>
                  <option value="">Unassigned</option>
                  {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Reporter (AI)</label>
                <select value={reporter} onChange={e => {
                  const name = e.target.value;
                  const agent = agents.find(a => a.name === name);
                  setReporter(name);
                  onUpdate(ticket.id, { reporter: name, reporter_id: agent?.id || '' });
                }} style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', width: '100%' }}>
                  <option value="">None</option>
                  {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              </div>
            </div>

            {/* Description */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ ...labelStyle, marginBottom: 6 }}>Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)}
                onBlur={() => description !== ticket.description && saveField('description', description)}
                placeholder="Add description..." rows={3}
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '10px 12px', color: '#e2e8f0', fontSize: '13px', resize: 'vertical', outline: 'none', lineHeight: 1.6 }}
              />
            </div>

            {/* Notification Channels */}
            {channels.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Notification Channels</label>
                <div style={{
                  background: '#0f172a', border: '1px solid #334155', borderRadius: 8,
                  padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  {channels.map(ch => {
                    const isSelected = selectedChannelIds.includes(ch.id);
                    return (
                      <label key={ch.id} style={{
                        display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                        padding: '4px 6px', borderRadius: 4,
                        background: isSelected ? '#6366f115' : 'transparent',
                      }}>
                        <input type="checkbox" checked={isSelected}
                          onChange={() => {
                            if (isSelected && selectedChannelIds.length <= 1) return;
                            const next = isSelected
                              ? selectedChannelIds.filter(id => id !== ch.id)
                              : [...selectedChannelIds, ch.id];
                            setSelectedChannelIds(next);
                            onUpdate(ticket.id, { channel_ids: next });
                          }}
                          style={{ accentColor: '#6366f1' }}
                        />
                        <span style={{ fontSize: '12px', color: '#e2e8f0', fontWeight: 500 }}>{ch.name}</span>
                        <span style={{ fontSize: '10px', color: ch.is_active ? '#34d399' : '#64748b', marginLeft: 'auto' }}>{ch.type}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Child Tickets (depth=2 inline only, no further nesting) */}
            <ChildTicketList
              parentTicket={ticket}
              agents={agents}
              maxDepth={2}
              onCreateChild={onCreateChild}
              onUpdateChild={(id, data) => onUpdate(id, data)}
              onDeleteChild={onDeleteChild}
            />

            {/* Comments */}
            <div style={{ marginTop: 20 }}>
              <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1', marginBottom: 10 }}>
                Comments ({(ticket.comments || []).length})
              </h4>

              {(ticket.comments || []).map(c => {
                const isSystem = c.author_type === 'system';
                const badgeConfig = isSystem
                  ? { bg: '#1c1917', color: '#a8a29e', label: 'System' }
                  : c.author_type === 'agent'
                  ? { bg: '#1e1b4b', color: '#a78bfa', label: 'Agent' }
                  : { bg: '#0c4a6e', color: '#38bdf8', label: 'User' };
                const images = c.images || [];

                return (
                  <div key={c.id} style={{
                    background: isSystem ? '#0c0a09' : '#0f172a',
                    border: `1px solid ${isSystem ? '#292524' : '#334155'}`,
                    borderRadius: 8, padding: isSystem ? '8px 12px' : 12, marginBottom: 8,
                    ...(isSystem ? { borderLeft: '3px solid #78716c' } : {}),
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isSystem ? 2 : 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                          background: badgeConfig.bg, color: badgeConfig.color, textTransform: 'uppercase',
                        }}>{badgeConfig.label}</span>
                        {!isSystem && <span style={{ fontSize: '12px', fontWeight: 600, color: badgeConfig.color }}>{c.author}</span>}
                      </div>
                      <span style={{ fontSize: '11px', color: '#64748b' }}>{new Date(c.created_at).toLocaleString()}</span>
                    </div>
                    <p style={{ fontSize: isSystem ? '12px' : '13px', color: isSystem ? '#a8a29e' : '#cbd5e1', lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0 }}>{c.content}</p>
                    {images.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {images.map((img, idx) => (
                          <img key={idx}
                            src={`data:${img.mimetype};base64,${img.data}`}
                            alt={img.filename}
                            onClick={() => setImagePreview(`data:${img.mimetype};base64,${img.data}`)}
                            style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 6, cursor: 'pointer', border: '1px solid #334155' }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Comment input */}
              <div style={{ marginTop: 8 }}>
                {commentImages.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                    {commentImages.map((img, idx) => (
                      <div key={idx} style={{ position: 'relative' }}>
                        <img src={`data:${img.mimetype};base64,${img.data}`} alt={img.filename}
                          style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid #334155' }} />
                        <button onClick={() => setCommentImages(prev => prev.filter((_, i) => i !== idx))}
                          style={{ position: 'absolute', top: -4, right: -4, background: '#ef4444', color: 'white', border: 'none', borderRadius: '50%', width: 16, height: 16, fontSize: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>x</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={handleImageAttach} title="Attach image" style={{
                    background: '#334155', color: '#94a3b8', border: 'none', borderRadius: 6,
                    padding: '6px 10px', fontSize: '14px', cursor: 'pointer',
                  }}>📎</button>
                  <input value={commentContent} onChange={e => setCommentContent(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitComment(); } }}
                    placeholder={user ? `${user.name}(으)로 댓글 작성...` : 'Write a comment...'}
                    style={{ flex: 1, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', outline: 'none' }}
                  />
                  <button onClick={handleSubmitComment} disabled={!commentContent.trim()} style={{
                    background: commentContent.trim() ? '#6366f1' : '#334155', color: 'white', border: 'none', borderRadius: 6,
                    padding: '6px 14px', fontSize: '12px', fontWeight: 600, cursor: commentContent.trim() ? 'pointer' : 'not-allowed',
                  }}>Send</button>
                </div>
              </div>
            </div>
          </>
        ) : (
          /* Activity Tab */
          <div>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1', marginBottom: 12 }}>
              Activity Log
            </h4>
            {activities.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#64748b', fontSize: '13px' }}>
                No activity recorded yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {activities.map(log => (
                  <div key={log.id} style={{
                    background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                    padding: '8px 12px', fontSize: '12px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                        {log.action.replace('_', ' ').toUpperCase()} - {log.entity_type}
                      </span>
                      <span style={{ color: '#64748b', fontSize: '11px' }}>
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                    </div>
                    {log.field_changed && (
                      <div style={{ color: '#94a3b8' }}>
                        Field: {log.field_changed}
                        {log.old_value && ` | From: ${log.old_value}`}
                        {log.new_value && ` | To: ${log.new_value}`}
                      </div>
                    )}
                    {log.actor_name && (
                      <div style={{ color: '#64748b', marginTop: 2 }}>By: {log.actor_name}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Image preview modal */}
      {imagePreview && (
        <div onClick={() => setImagePreview(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, cursor: 'pointer',
        }}>
          <img src={imagePreview} alt="Preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data:mimetype;base64, prefix
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
```

- [ ] **Step 2: Add slide-in animation CSS**

Add this CSS animation to the app. Find the global CSS file (likely `apps/client/src/index.css` or `App.css`) and add:

```css
@keyframes slideInRight {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/components/SubtaskPanel.tsx apps/client/src/index.css
git commit -m "feat: create SubtaskPanel component with Jira-style slide-in panel"
```

---

### Task 14: Frontend — Update TicketDetail to use ChildTicketList, SubtaskPanel, and comment images

**Files:**
- Modify: `apps/client/src/components/TicketDetail.tsx`

- [ ] **Step 1: Rewrite TicketDetail.tsx**

Replace the entire file `apps/client/src/components/TicketDetail.tsx`:

```tsx
import React, { useState, useEffect } from 'react';
import { Ticket, Agent, Channel, ActivityLog } from '../types';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import ChildTicketList from './SubtaskList';
import SubtaskPanel from './SubtaskPanel';

interface TicketDetailProps {
  ticket: Ticket;
  columnName: string;
  agents: Agent[];
  channels: Channel[];
  onClose: () => void;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
  onCreateChild: (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => void;
  onDeleteChild: (childId: string) => void;
  onAddComment: (ticketId: string, content: string, images?: { filename: string; mimetype: string; data: string }[]) => void;
}

const priorityColors: Record<string, string> = {
  low: '#94a3b8',
  medium: '#60a5fa',
  high: '#fbbf24',
  critical: '#ef4444',
};

export default function TicketDetail({
  ticket, columnName, agents, channels, onClose, onUpdate, onDelete,
  onCreateChild, onDeleteChild, onAddComment,
}: TicketDetailProps) {
  const { user } = useAuth();
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [priority, setPriority] = useState(ticket.priority);
  const resolveAgentName = (id: string | undefined, name: string) => {
    if (id) {
      const agent = agents.find(a => a.id === id);
      if (agent) return agent.name;
    }
    return name;
  };
  const [assignee, setAssignee] = useState(resolveAgentName(ticket.assignee_id, ticket.assignee));
  const [reporter, setReporter] = useState(resolveAgentName(ticket.reporter_id, ticket.reporter));
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>(ticket.channel_ids || []);
  const [commentContent, setCommentContent] = useState('');
  const [commentImages, setCommentImages] = useState<{ filename: string; mimetype: string; data: string }[]>([]);
  const [activeTab, setActiveTab] = useState<'detail' | 'activity'>('detail');
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [selectedChild, setSelectedChild] = useState<Ticket | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description);
    setPriority(ticket.priority);
    setAssignee(resolveAgentName(ticket.assignee_id, ticket.assignee));
    setReporter(resolveAgentName(ticket.reporter_id, ticket.reporter));
    setSelectedChannelIds(ticket.channel_ids || []);
  }, [ticket.id, ticket.title, ticket.description, ticket.priority, ticket.assignee, ticket.reporter, ticket.updated_at]);

  // Keep selectedChild in sync with ticket data
  useEffect(() => {
    if (selectedChild) {
      const updated = (ticket.children || []).find(c => c.id === selectedChild.id);
      if (updated) {
        setSelectedChild(updated);
      } else {
        setSelectedChild(null);
      }
    }
  }, [ticket.children]);

  useEffect(() => {
    if (activeTab === 'activity') {
      api.getTicketActivity(ticket.id).then(setActivities).catch(() => {});
    }
  }, [activeTab, ticket.id]);

  const saveField = (field: string, value: any) => {
    onUpdate(ticket.id, { [field]: value });
  };

  const handleImageAttach = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      const newImages: typeof commentImages = [];
      for (let i = 0; i < files.length && commentImages.length + newImages.length < 5; i++) {
        const file = files[i];
        if (file.size > 5 * 1024 * 1024) continue;
        const data = await fileToBase64(file);
        newImages.push({ filename: file.name, mimetype: file.type, data });
      }
      setCommentImages(prev => [...prev, ...newImages].slice(0, 5));
    };
    input.click();
  };

  const handleSubmitComment = () => {
    if (commentContent.trim()) {
      onAddComment(ticket.id, commentContent.trim(), commentImages.length > 0 ? commentImages : undefined);
      setCommentContent('');
      setCommentImages([]);
    }
  };

  const labelStyle = { fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' as const, display: 'block', marginBottom: 4 };

  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
        paddingTop: '5vh', zIndex: 1000, overflowY: 'auto',
      }} onClick={onClose}>
        <div onClick={e => e.stopPropagation()} style={{
          background: '#1e293b', borderRadius: 12, width: '100%', maxWidth: 700,
          maxHeight: '90vh', overflowY: 'auto', border: '1px solid #334155',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}>
          {/* Header */}
          <div style={{
            padding: '16px 20px', borderBottom: '1px solid #334155',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                fontSize: '11px', padding: '3px 8px', borderRadius: 4,
                background: '#0f172a', color: '#94a3b8', fontWeight: 500,
              }}>#{ticket.id}</span>
              <span style={{
                fontSize: '11px', padding: '3px 8px', borderRadius: 4,
                background: '#0f172a', color: '#94a3b8',
              }}>{columnName}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { onDelete(ticket.id); onClose(); }} style={{
                background: '#7f1d1d', color: '#fca5a5', border: 'none', borderRadius: 6,
                padding: '4px 12px', fontSize: '12px', cursor: 'pointer',
              }}>Delete</button>
              <button onClick={onClose} style={{
                background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 6,
                padding: '4px 12px', fontSize: '16px', cursor: 'pointer',
              }}>x</button>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #334155' }}>
            {(['detail', 'activity'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding: '8px 16px', background: 'transparent', border: 'none',
                borderBottom: activeTab === tab ? '2px solid #6366f1' : '2px solid transparent',
                color: activeTab === tab ? '#e2e8f0' : '#64748b',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
              }}>{tab}</button>
            ))}
          </div>

          {/* Body */}
          <div style={{ padding: 20 }}>
            {activeTab === 'detail' ? (
              <>
                {/* Title */}
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onBlur={() => title !== ticket.title && saveField('title', title)}
                  style={{
                    width: '100%', background: 'transparent', border: 'none', color: '#f1f5f9',
                    fontSize: '20px', fontWeight: 700, outline: 'none', marginBottom: 16,
                  }}
                />

                {/* Meta row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Priority</label>
                    <select
                      value={priority}
                      onChange={e => { setPriority(e.target.value as any); saveField('priority', e.target.value); }}
                      style={{
                        background: '#0f172a', border: `2px solid ${priorityColors[priority]}`,
                        borderRadius: 6, padding: '6px 10px',
                        color: priorityColors[priority], fontSize: '12px', fontWeight: 600, width: '100%',
                      }}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>

                  <div>
                    <label style={labelStyle}>Assignee (AI)</label>
                    <select
                      value={assignee}
                      onChange={e => {
                        const name = e.target.value;
                        const agent = agents.find(a => a.name === name);
                        setAssignee(name);
                        onUpdate(ticket.id, { assignee: name, assignee_id: agent?.id || '' });
                      }}
                      style={{
                        background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                        padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', width: '100%',
                      }}
                    >
                      <option value="">Unassigned</option>
                      {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label style={labelStyle}>Reporter (AI)</label>
                    <select
                      value={reporter}
                      onChange={e => {
                        const name = e.target.value;
                        const agent = agents.find(a => a.name === name);
                        setReporter(name);
                        onUpdate(ticket.id, { reporter: name, reporter_id: agent?.id || '' });
                      }}
                      style={{
                        background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                        padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', width: '100%',
                      }}
                    >
                      <option value="">None</option>
                      {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label style={labelStyle}>Created</label>
                    <span style={{ fontSize: '12px', color: '#94a3b8', padding: '6px 0', display: 'block' }}>
                      {new Date(ticket.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                {/* Description */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ ...labelStyle, marginBottom: 6 }}>Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    onBlur={() => description !== ticket.description && saveField('description', description)}
                    placeholder="Add description..."
                    rows={4}
                    style={{
                      width: '100%', background: '#0f172a', border: '1px solid #334155',
                      borderRadius: 8, padding: '10px 12px', color: '#e2e8f0', fontSize: '13px',
                      resize: 'vertical', outline: 'none', lineHeight: 1.6,
                    }}
                  />
                </div>

                {/* Notification Channels */}
                {channels.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ ...labelStyle, marginBottom: 6 }}>Notification Channels</label>
                    <div style={{
                      background: '#0f172a', border: '1px solid #334155', borderRadius: 8,
                      padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
                    }}>
                      {channels.map(ch => {
                        const isSelected = selectedChannelIds.includes(ch.id);
                        return (
                          <label key={ch.id} style={{
                            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                            padding: '4px 6px', borderRadius: 4,
                            background: isSelected ? '#6366f115' : 'transparent',
                          }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                if (isSelected && selectedChannelIds.length <= 1) return;
                                const next = isSelected
                                  ? selectedChannelIds.filter(id => id !== ch.id)
                                  : [...selectedChannelIds, ch.id];
                                setSelectedChannelIds(next);
                                onUpdate(ticket.id, { channel_ids: next });
                              }}
                              style={{ accentColor: '#6366f1', cursor: isSelected && selectedChannelIds.length <= 1 ? 'not-allowed' : 'pointer' }}
                            />
                            <span style={{ fontSize: '12px', color: '#e2e8f0', fontWeight: 500 }}>{ch.name}</span>
                            <span style={{
                              fontSize: '10px', color: ch.is_active ? '#34d399' : '#64748b',
                              marginLeft: 'auto',
                            }}>{ch.type}{ch.is_active ? '' : ' (inactive)'}</span>
                          </label>
                        );
                      })}
                      {selectedChannelIds.length === 0 && (
                        <div style={{ fontSize: '11px', color: '#ef4444', padding: '4px 6px', background: '#ef444415', borderRadius: 4 }}>
                          No channel selected — please select at least one channel to receive notifications
                        </div>
                      )}
                      {selectedChannelIds.length === 1 && (
                        <div style={{ fontSize: '11px', color: '#fbbf24', padding: '2px 6px' }}>
                          Last channel — cannot be removed
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Child Tickets (Subtasks) */}
                <ChildTicketList
                  parentTicket={ticket}
                  agents={agents}
                  maxDepth={2}
                  onCreateChild={onCreateChild}
                  onUpdateChild={(id, data) => onUpdate(id, data)}
                  onDeleteChild={onDeleteChild}
                  onSelectChild={setSelectedChild}
                />

                {/* Comments */}
                <div style={{ marginTop: 20 }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1', marginBottom: 10 }}>
                    Comments ({ticket.comments.length})
                  </h4>

                  {ticket.comments.map(c => {
                    const isSystem = c.author_type === 'system';
                    const badgeConfig = isSystem
                      ? { bg: '#1c1917', color: '#a8a29e', label: 'System' }
                      : c.author_type === 'agent'
                      ? { bg: '#1e1b4b', color: '#a78bfa', label: 'Agent' }
                      : { bg: '#0c4a6e', color: '#38bdf8', label: 'User' };
                    const images = c.images || [];

                    return (
                      <div key={c.id} style={{
                        background: isSystem ? '#0c0a09' : '#0f172a',
                        border: `1px solid ${isSystem ? '#292524' : '#334155'}`,
                        borderRadius: 8,
                        padding: isSystem ? '8px 12px' : 12,
                        marginBottom: 8,
                        ...(isSystem ? { borderLeft: '3px solid #78716c' } : {}),
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isSystem ? 2 : 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                              background: badgeConfig.bg, color: badgeConfig.color,
                              textTransform: 'uppercase',
                            }}>{badgeConfig.label}</span>
                            {!isSystem && (
                              <span style={{ fontSize: '12px', fontWeight: 600, color: badgeConfig.color }}>{c.author}</span>
                            )}
                          </div>
                          <span style={{ fontSize: '11px', color: '#64748b' }}>{new Date(c.created_at).toLocaleString()}</span>
                        </div>
                        <p style={{
                          fontSize: isSystem ? '12px' : '13px',
                          color: isSystem ? '#a8a29e' : '#cbd5e1',
                          lineHeight: 1.5, whiteSpace: 'pre-wrap',
                          margin: 0,
                        }}>{c.content}</p>
                        {images.length > 0 && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                            {images.map((img, idx) => (
                              <img key={idx}
                                src={`data:${img.mimetype};base64,${img.data}`}
                                alt={img.filename}
                                onClick={() => setImagePreview(`data:${img.mimetype};base64,${img.data}`)}
                                style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 6, cursor: 'pointer', border: '1px solid #334155' }}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Comment input */}
                  <div style={{ marginTop: 8 }}>
                    {commentImages.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                        {commentImages.map((img, idx) => (
                          <div key={idx} style={{ position: 'relative' }}>
                            <img src={`data:${img.mimetype};base64,${img.data}`} alt={img.filename}
                              style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid #334155' }} />
                            <button onClick={() => setCommentImages(prev => prev.filter((_, i) => i !== idx))}
                              style={{ position: 'absolute', top: -4, right: -4, background: '#ef4444', color: 'white', border: 'none', borderRadius: '50%', width: 16, height: 16, fontSize: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>x</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={handleImageAttach} title="Attach image" style={{
                        background: '#334155', color: '#94a3b8', border: 'none', borderRadius: 6,
                        padding: '6px 10px', fontSize: '14px', cursor: 'pointer',
                      }}>📎</button>
                      <input
                        value={commentContent}
                        onChange={e => setCommentContent(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitComment(); } }}
                        placeholder={user ? `${user.name}(으)로 댓글 작성...` : 'Write a comment...'}
                        style={{
                          flex: 1, background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                          padding: '6px 10px', color: '#e2e8f0', fontSize: '12px', outline: 'none',
                        }}
                      />
                      <button onClick={handleSubmitComment} disabled={!commentContent.trim()} style={{
                        background: commentContent.trim() ? '#6366f1' : '#334155', color: 'white', border: 'none', borderRadius: 6,
                        padding: '6px 14px', fontSize: '12px', fontWeight: 600, cursor: commentContent.trim() ? 'pointer' : 'not-allowed',
                      }}>Send</button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              /* Activity Tab */
              <div>
                <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1', marginBottom: 12 }}>
                  Activity Log
                </h4>
                {activities.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 20, color: '#64748b', fontSize: '13px' }}>
                    No activity recorded yet.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {activities.map(log => (
                      <div key={log.id} style={{
                        background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                        padding: '8px 12px', fontSize: '12px',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                            {log.action.replace('_', ' ').toUpperCase()} - {log.entity_type}
                          </span>
                          <span style={{ color: '#64748b', fontSize: '11px' }}>
                            {new Date(log.created_at).toLocaleString()}
                          </span>
                        </div>
                        {log.field_changed && (
                          <div style={{ color: '#94a3b8' }}>
                            Field: {log.field_changed}
                            {log.old_value && ` | From: ${log.old_value}`}
                            {log.new_value && ` | To: ${log.new_value}`}
                          </div>
                        )}
                        {log.actor_name && (
                          <div style={{ color: '#64748b', marginTop: 2 }}>By: {log.actor_name}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Subtask slide panel */}
      {selectedChild && (
        <SubtaskPanel
          ticket={selectedChild}
          agents={agents}
          channels={channels}
          onClose={() => setSelectedChild(null)}
          onUpdate={onUpdate}
          onDelete={(id) => { onDeleteChild(id); setSelectedChild(null); }}
          onCreateChild={onCreateChild}
          onDeleteChild={onDeleteChild}
          onAddComment={onAddComment}
        />
      )}

      {/* Image preview modal */}
      {imagePreview && (
        <div onClick={() => setImagePreview(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, cursor: 'pointer',
        }}>
          <img src={imagePreview} alt="Preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
        </div>
      )}
    </>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/client/src/components/TicketDetail.tsx
git commit -m "feat: update TicketDetail with child tickets, subtask panel, and comment images"
```

---

### Task 15: Frontend — Update Board.tsx handlers

**Files:**
- Modify: `apps/client/src/components/Board.tsx`

- [ ] **Step 1: Update Board.tsx to use new handler signatures**

Key changes to `apps/client/src/components/Board.tsx`:

1. Remove the old subtask handler imports from useBoard: `createSubtask, updateSubtask, deleteSubtask` → `createChildTicket`
2. Remove `handleCreateSubtask`, `handleUpdateSubtask`, `handleToggleSubtask`, `handleDeleteSubtask`
3. Add `handleCreateChild` and `handleDeleteChild`
4. Update TicketDetail props

Replace the destructured useBoard result (around line 66-70):
```typescript
  const {
    board, users, agents, channels, loading: boardLoading, error, refresh,
    createTicket, updateTicket, moveTicket, deleteTicket,
    createChildTicket, addComment,
    createColumn, updateColumn, deleteColumn,
  } = useBoard(currentBoardId ?? '');
```

Remove old subtask handlers (lines ~117-131) and replace with:
```typescript
  const handleCreateChild = useCallback(async (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => {
    await wrapAction(() => createChildTicket(parentId, data), 'Subtask created');
  }, [wrapAction, createChildTicket]);

  const handleDeleteChild = useCallback(async (childId: string) => {
    await wrapAction(() => deleteTicket(childId), 'Subtask deleted');
  }, [wrapAction, deleteTicket]);

  const handleAddComment = useCallback(async (ticketId: string, content: string, images?: { filename: string; mimetype: string; data: string }[]) => {
    await wrapAction(() => addComment(ticketId, content, images || []), 'Comment added');
  }, [wrapAction, addComment]);
```

Update TicketDetail usage (around line 285-300):
```tsx
            <TicketDetail
              ticket={selectedTicket}
              columnName={selectedColumnName}
              agents={agents}
              channels={channels}
              onClose={handleCloseDetail}
              onUpdate={handleUpdateTicket}
              onDelete={handleDeleteTicket}
              onCreateChild={handleCreateChild}
              onDeleteChild={handleDeleteChild}
              onAddComment={handleAddComment}
            />
```

- [ ] **Step 2: Commit**

```bash
git add apps/client/src/components/Board.tsx
git commit -m "feat: update Board handlers for child tickets and comment images"
```

---

### Task 16: Build and verify

- [ ] **Step 1: Build the server**

```bash
cd ai-workflow-board && npx turbo build --filter=server
```

Expected: Successful build with no TypeScript errors.

- [ ] **Step 2: Build the client**

```bash
cd ai-workflow-board && npx turbo build --filter=client
```

Expected: Successful build with no TypeScript errors.

- [ ] **Step 3: Fix any compilation errors**

If there are errors, fix them based on the error messages. Common issues:
- Missing imports
- Type mismatches between old Subtask and new children
- Unused variables from removed subtask code

- [ ] **Step 4: Start the dev server and verify**

```bash
cd ai-workflow-board && npx turbo dev
```

Manual checks:
- Board loads correctly, showing only root tickets
- Clicking a ticket opens TicketDetail
- Child ticket list shows correctly
- Creating a child ticket works
- Clicking a child ticket opens the slide panel
- All fields in the slide panel work
- Comments with images work
- Activity log works

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build issues from ticket hierarchy migration"
```

---

### Task 17: Data migration — Convert existing Subtask data to child Tickets

- [ ] **Step 1: Add migration logic to database.module.ts onModuleInit**

In `apps/server/src/database/database.module.ts`, add a migration step in the `onModuleInit` method. After the existing workspace seeding logic, add:

```typescript
    // Migrate: convert old subtasks table to child tickets
    try {
      const hasSubtasks = await this.dataSource.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='subtasks'`
      ).catch(() => []);

      if (hasSubtasks.length > 0) {
        const ticketRepo = this.dataSource.getRepository(Ticket);
        const subtasks = await this.dataSource.query('SELECT * FROM subtasks ORDER BY ticket_id, position');

        for (const st of subtasks) {
          await ticketRepo.save(ticketRepo.create({
            parent_id: st.ticket_id,
            depth: 1,
            column_id: null as any,
            title: st.title,
            description: st.description || '',
            priority: st.priority || 'medium',
            status: st.status || (st.done ? 'done' : 'todo'),
            assignee: st.assignee || '',
            reporter: st.reporter || '',
            assignee_id: st.assignee_id || '',
            reporter_id: st.reporter_id || '',
            labels: st.labels || '[]',
            channel_ids: '[]',
            position: st.position || 0,
          }));
        }

        // Drop the old subtasks table
        await this.dataSource.query('DROP TABLE IF EXISTS subtasks');
        this.dbLog(`Migrated ${subtasks.length} subtask(s) to child tickets and dropped subtasks table`);
      }
    } catch (e) {
      this.dbLog(`Subtask migration skipped or already done: ${(e as Error).message}`);
    }
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/database/database.module.ts
git commit -m "feat: add data migration to convert subtasks table to child tickets"
```
