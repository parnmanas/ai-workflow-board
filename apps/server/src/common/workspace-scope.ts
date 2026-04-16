import { DataSource, EntityTarget, FindManyOptions, FindOneOptions, DeepPartial, Repository, ObjectLiteral } from 'typeorm';

// WorkspaceScope enforces workspace_id scoping on all repository operations.
// Usage: WorkspaceScope.of(dataSource, Board, workspaceId).find({ where: { name: 'x' } })
// The generic constraint <T extends { workspace_id: string }> ensures compile-time enforcement:
// only entities with a workspace_id column can be scoped this way.
export class WorkspaceScope {
  static of<T extends { workspace_id: string }>(
    dataSource: DataSource,
    entity: EntityTarget<T>,
    workspaceId: string,
  ) {
    const repo: Repository<T> = dataSource.getRepository(entity);

    return {
      find(options?: FindManyOptions<T>) {
        const where = { ...(options?.where as object || {}), workspace_id: workspaceId };
        return repo.find({ ...options, where } as FindManyOptions<T>);
      },

      findOne(options: FindOneOptions<T>) {
        const where = { ...(options?.where as object || {}), workspace_id: workspaceId };
        return repo.findOne({ ...options, where } as FindOneOptions<T>);
      },

      async create(data: DeepPartial<T>) {
        const entity = repo.create({ ...data, workspace_id: workspaceId } as DeepPartial<T>);
        return repo.save(entity);
      },

      async save(entityInstance: T) {
        entityInstance.workspace_id = workspaceId;
        return repo.save(entityInstance);
      },

      delete(criteria: any) {
        return repo.delete({ ...criteria, workspace_id: workspaceId });
      },

      count(options?: FindManyOptions<T>) {
        const where = { ...(options?.where as object || {}), workspace_id: workspaceId };
        return repo.count({ ...options, where } as FindManyOptions<T>);
      },
    };
  }

  // For cross-workspace admin queries — bypasses workspace scoping intentionally.
  static asAdmin<T extends ObjectLiteral>(dataSource: DataSource, entity: EntityTarget<T>): Repository<T> {
    return dataSource.getRepository(entity);
  }
}
