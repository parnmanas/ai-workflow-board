import { cliDescriptor } from '../../common/cli-catalog';
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentTemplate } from '../../entities/AgentTemplate';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { validateAgentRuntimeConfig } from '../../common/runtime-config';

@Controller('api/agent-templates')
@UseGuards(AuthGuard)
export class AgentTemplatesController {
  constructor(
    @InjectRepository(AgentTemplate) private readonly templates: Repository<AgentTemplate>,
    @InjectRepository(RuntimeHost) private readonly hosts: Repository<RuntimeHost>,
  ) {}

  @Get('hosts')
  listHosts() { return this.hosts.find({ select: { id: true, name: true }, order: { name: 'ASC' } }); }

  @Get()
  list() { return this.templates.find({ order: { name: 'ASC', id: 'ASC' } }); }

  private async normalize(body: any) {
    const allowed = new Set(['name', 'host_id', 'cli', 'model', 'effort', 'runtime_config']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !allowed.has(k))) {
      throw new BadRequestException('Only name, host_id, cli, model, effort and runtime_config may be saved in an Agent template');
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const host_id = typeof body.host_id === 'string' ? body.host_id.trim() : '';
    const cli = typeof body.cli === 'string' ? body.cli.trim().toLowerCase() : '';
    if (!name || name.length > 120) throw new BadRequestException('A name of 1–120 characters is required');
    if (!host_id || !await this.hosts.existsBy({ id: host_id })) throw new BadRequestException('Runtime Host not found');
    for (const key of ['model', 'effort']) {
      if (body[key] != null && (typeof body[key] !== 'string' || body[key].length > 250)) throw new BadRequestException(`Invalid ${key}`);
    }
    let runtime_config;
    try { runtime_config = validateAgentRuntimeConfig(cli, body.runtime_config); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    if (body.effort && !cliDescriptor(cli)?.effort?.keys.includes('effort')) throw new BadRequestException('This CLI does not support a launch effort override');
    return { name, host_id, cli, model: body.model?.trim() || null, effort: body.effort?.trim() || null, runtime_config };
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('admin.access')
  async create(@Body() body: any) {
    return this.templates.save(this.templates.create(await this.normalize(body)));
  }

  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('admin.access')
  async update(@Param('id') id: string, @Body() body: any) {
    const current = await this.templates.findOneBy({ id });
    if (!current) throw new NotFoundException('Agent template not found');
    const { name, host_id, cli, model, effort, runtime_config } = current;
    const next = await this.normalize({ name, host_id, cli, model, effort, runtime_config, ...body });
    return this.templates.save(Object.assign(current, next));
  }

  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('admin.access')
  async remove(@Param('id') id: string) {
    if (!(await this.templates.delete(id)).affected) throw new NotFoundException('Agent template not found');
    return { ok: true };
  }
}
