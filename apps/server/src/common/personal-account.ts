import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { Account } from '../entities/Account';
import { User } from '../entities/User';

/** Never adopts existing work. Legacy attribution belongs to the explicit migration. */
export async function ensurePersonalAccount(manager: EntityManager, user: Pick<User, 'id' | 'name'>): Promise<Account> {
  const repo = manager.getRepository(Account);
  const where = { owner_user_id: user.id, kind: 'personal' as const };
  const existing = await repo.findOneBy(where);
  if (existing) return existing;
  // Concurrent login/request paths can arrive here together. The declared
  // unique index, not a process-local lock, makes creation safe on both DBs.
  await repo.createQueryBuilder().insert().values({
    id: randomUUID(), name: user.name, ...where,
  }).orIgnore().execute();
  return repo.findOneByOrFail(where);
}
