import { NotFoundException } from '@nestjs/common';
import { ObjectLiteral, Repository, FindOneOptions } from 'typeorm';

export async function findOrFail<T extends ObjectLiteral>(
  repo: Repository<T>,
  options: FindOneOptions<T>,
  notFoundMessage: string,
): Promise<T> {
  const entity = await repo.findOne(options);
  if (!entity) throw new NotFoundException(notFoundMessage);
  return entity;
}
