import { DataSource } from 'typeorm';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';

export async function openDescendants(dataSource: DataSource, rootId: string): Promise<Ticket[]> {
  const repo = dataSource.getRepository(Ticket);
  const result: Ticket[] = [];
  let parentIds = [rootId];
  while (parentIds.length) {
    const rows = await repo.createQueryBuilder('t').where('t.parent_id IN (:...parentIds)', { parentIds }).getMany();
    result.push(...rows);
    parentIds = rows.map(row => row.id);
  }
  return result.filter(row => row.status !== 'done');
}

export async function subtaskGateBlocksMove(dataSource: DataSource, ticket: Ticket, destinationId: string): Promise<boolean> {
  if (!ticket.column_id || destinationId === ticket.column_id) return false;
  const columns = dataSource.getRepository(BoardColumn);
  const [source, destination] = await Promise.all([
    columns.findOne({ where: { id: ticket.column_id } }),
    columns.findOne({ where: { id: destinationId } }),
  ]);
  if (!source?.process_subtasks || !destination || destination.position <= source.position) return false;
  return (await openDescendants(dataSource, ticket.id)).length > 0;
}

/** 다른 보드로의 이동처럼 목적지 position을 현재 보드와 비교할 수 없는 컬럼 이탈 게이트. */
export async function subtaskGateBlocksExit(dataSource: DataSource, ticket: Ticket): Promise<boolean> {
  if (!ticket.column_id) return false;
  const source = await dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
  if (!source?.process_subtasks) return false;
  return (await openDescendants(dataSource, ticket.id)).length > 0;
}
