import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { BUILTIN_ROLES } from '../../db';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const SLUG_MAX = 64;
const NAME_MAX = 128;
const PROMPT_MAX = 8192;
const DESC_MAX = 1024;

/**
 * `slug` is what mention syntax (`@[role:slug|...]`) and routing_config
 * resolve against. We constrain it to URL-safe characters so it can be
 * embedded in the structured token without escaping.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * CRUD for the per-workspace WorkspaceRole entity. Seeded built-in slugs
 * (`assignee` / `reporter` / `reviewer`) are stored in the same table —
 * they're just rows with `is_builtin: true` and no special-case logic
 * once the migration has run.
 *
 * Deletion is the only operation that needs guarding: a role can't be
 * removed while any TicketRoleAssignment still references it. The caller
 * must reassign or clear those slots first.
 */
@Injectable()
export class WorkspaceRolesService {
  constructor(
    @InjectRepository(WorkspaceRole)
    private readonly roleRepo: Repository<WorkspaceRole>,

    @InjectRepository(TicketRoleAssignment)
    private readonly assignRepo: Repository<TicketRoleAssignment>,
  ) {}

  /**
   * Seed the BUILTIN_ROLES preset into a workspace. Idempotent: existing
   * slugs are left alone so this can run on every workspace create AND on
   * old workspaces brought in by the v0.34 migration without producing
   * duplicates. Returns the count of rows actually inserted.
   *
   * Called from:
   *   - DatabaseModule first-run default-workspace seed
   *   - REST POST /api/workspaces
   *   - MCP create_workspace tool
   *   - Migration 1760000000008-SeedWorkspaceRoles (data backfill)
   */
  async seedBuiltinRoles(workspaceId: string): Promise<number> {
    if (!workspaceId) return 0;
    let inserted = 0;
    for (const def of BUILTIN_ROLES) {
      const existing = await this.roleRepo.findOne({
        where: { workspace_id: workspaceId, slug: def.slug },
      });
      if (existing) continue;
      await this.roleRepo.save(this.roleRepo.create({
        workspace_id: workspaceId,
        slug: def.slug,
        name: def.name,
        role_prompt: def.role_prompt,
        description: def.description,
        position: def.position,
        is_builtin: true,
      }));
      inserted++;
    }
    return inserted;
  }

  async list(workspaceId: string): Promise<WorkspaceRole[]> {
    if (!workspaceId) return [];
    return this.roleRepo.find({
      where: { workspace_id: workspaceId },
      order: { position: 'ASC', created_at: 'ASC' },
    });
  }

  async get(roleId: string): Promise<WorkspaceRole | null> {
    return this.roleRepo.findOne({ where: { id: roleId } });
  }

  async getBySlug(workspaceId: string, slug: string): Promise<WorkspaceRole | null> {
    return this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
  }

  async create(
    workspaceId: string,
    body: {
      slug: string;
      name: string;
      role_prompt?: string;
      description?: string;
      position?: number;
    },
  ): Promise<WorkspaceRole> {
    this._validateSlug(body.slug);
    this._validateName(body.name);
    if (body.role_prompt && body.role_prompt.length > PROMPT_MAX) {
      throw makeError(400, `role_prompt exceeds ${PROMPT_MAX} characters`);
    }
    if (body.description && body.description.length > DESC_MAX) {
      throw makeError(400, `description exceeds ${DESC_MAX} characters`);
    }
    const collision = await this.getBySlug(workspaceId, body.slug);
    if (collision) {
      throw makeError(409, `slug "${body.slug}" already exists in this workspace`);
    }
    const maxPos = await this._maxPosition(workspaceId);
    const row = this.roleRepo.create({
      workspace_id: workspaceId,
      slug: body.slug,
      name: body.name,
      role_prompt: body.role_prompt ?? '',
      description: body.description ?? '',
      position: body.position ?? maxPos + 1,
      is_builtin: false,
    });
    return this.roleRepo.save(row);
  }

  async update(
    roleId: string,
    body: {
      slug?: string;
      name?: string;
      role_prompt?: string;
      description?: string;
      position?: number;
    },
  ): Promise<WorkspaceRole> {
    const role = await this.get(roleId);
    if (!role) throw makeError(404, 'role not found');
    if (body.slug !== undefined && body.slug !== role.slug) {
      this._validateSlug(body.slug);
      const collision = await this.getBySlug(role.workspace_id, body.slug);
      if (collision && collision.id !== role.id) {
        throw makeError(409, `slug "${body.slug}" already exists in this workspace`);
      }
      role.slug = body.slug;
    }
    if (body.name !== undefined) {
      this._validateName(body.name);
      role.name = body.name;
    }
    if (body.role_prompt !== undefined) {
      if (body.role_prompt.length > PROMPT_MAX) {
        throw makeError(400, `role_prompt exceeds ${PROMPT_MAX} characters`);
      }
      role.role_prompt = body.role_prompt;
    }
    if (body.description !== undefined) {
      if (body.description.length > DESC_MAX) {
        throw makeError(400, `description exceeds ${DESC_MAX} characters`);
      }
      role.description = body.description;
    }
    if (body.position !== undefined) {
      role.position = body.position;
    }
    return this.roleRepo.save(role);
  }

  /**
   * Remove a role. Refused if any TicketRoleAssignment still points at it —
   * the caller must clear or reassign those slots first. This is the safety
   * net for built-in roles too: even though slug/name/prompt are editable,
   * a workspace with active tickets can't delete `assignee` out from under
   * itself.
   */
  async remove(roleId: string): Promise<void> {
    const role = await this.get(roleId);
    if (!role) throw makeError(404, 'role not found');
    const refCount = await this.assignRepo.count({ where: { role_id: roleId } });
    if (refCount > 0) {
      throw makeError(409, `cannot delete: ${refCount} ticket assignment(s) still reference this role`);
    }
    await this.roleRepo.delete({ id: roleId });
  }

  private _validateSlug(slug: string): void {
    if (!slug || typeof slug !== 'string') throw makeError(400, 'slug is required');
    if (slug.length > SLUG_MAX) throw makeError(400, `slug exceeds ${SLUG_MAX} characters`);
    if (!SLUG_RE.test(slug)) {
      throw makeError(
        400,
        'slug must be lowercase alphanumeric with optional hyphens, starting with letter or digit',
      );
    }
  }

  private _validateName(name: string): void {
    if (!name || typeof name !== 'string') throw makeError(400, 'name is required');
    if (name.length > NAME_MAX) throw makeError(400, `name exceeds ${NAME_MAX} characters`);
  }

  private async _maxPosition(workspaceId: string): Promise<number> {
    const result = await this.roleRepo
      .createQueryBuilder('r')
      .select('MAX(r.position)', 'max')
      .where('r.workspace_id = :wsId', { wsId: workspaceId })
      .getRawOne<{ max: number | null }>();
    return Number(result?.max ?? -1);
  }
}
