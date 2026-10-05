import { DataSource, EntityTarget, FindManyOptions, FindOneOptions, DeepPartial, Repository, ObjectLiteral } from 'typeorm';

// AccountScope enforces account_id scoping on all repository operations.
// Usage: AccountScope.of(dataSource, Board, accountId).find({ where: { name: 'x' } })
// The generic constraint <T extends { account_id: string }> ensures compile-time enforcement:
// only entities with a account_id column can be scoped this way.
export class AccountScope {
  static of<T extends { account_id: string }>(
    dataSource: DataSource,
    entity: EntityTarget<T>,
    accountId: string,
  ) {
    const repo: Repository<T> = dataSource.getRepository(entity);

    return {
      find(options?: FindManyOptions<T>) {
        const where = { ...(options?.where as object || {}), account_id: accountId };
        return repo.find({ ...options, where } as FindManyOptions<T>);
      },

      findOne(options: FindOneOptions<T>) {
        const where = { ...(options?.where as object || {}), account_id: accountId };
        return repo.findOne({ ...options, where } as FindOneOptions<T>);
      },

      async create(data: DeepPartial<T>) {
        const entity = repo.create({ ...data, account_id: accountId } as DeepPartial<T>);
        return repo.save(entity);
      },

      async save(entityInstance: T) {
        entityInstance.account_id = accountId;
        return repo.save(entityInstance);
      },

      delete(criteria: any) {
        return repo.delete({ ...criteria, account_id: accountId });
      },

      count(options?: FindManyOptions<T>) {
        const where = { ...(options?.where as object || {}), account_id: accountId };
        return repo.count({ ...options, where } as FindManyOptions<T>);
      },
    };
  }

  // For cross-workspace admin queries — bypasses workspace scoping intentionally.
  static asAdmin<T extends ObjectLiteral>(dataSource: DataSource, entity: EntityTarget<T>): Repository<T> {
    return dataSource.getRepository(entity);
  }
}
