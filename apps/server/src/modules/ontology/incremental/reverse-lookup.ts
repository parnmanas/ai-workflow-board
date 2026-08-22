// ticket 964014f5(증분 갱신, DESIGN.md 축 4) — Phase B의 reverse_edge_index
// 조회 + durability pre-filter(research-incremental.md §4.3). "심볼 X가
// 바뀌었다 -> X를 참조하는 파일은 어디인가"를 답하고, 변경이 volatile
// 파티션에서 일어났으면 stable/frozen 파일은 결과에서 제외한다.
import { In, type DataSource } from 'typeorm';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyReverseEdgeIndex } from '../../../entities/OntologyReverseEdgeIndex';

const ID_CHUNK_SIZE = 500; // persist.ts의 NODE_CHUNK_SIZE/EDGE_CHUNK_SIZE 선례와 동일한 값 — sql.js/Postgres 바인드 변수 한도 아래로 여유있게. research-incremental.md §5.4: 핫 심볼의 reverse-index fan-in은 "수천"까지 실제로 갈 수 있어 단일 IN(...)으로는 위험하다.

export interface FindAffectedFilesOptions {
  /** 이번 변경(Phase A가 재파싱한 파일) 자신의 durability가 volatile이
   *  아니면 true — research-incremental.md §4.3의 "unless that partition's
   *  own revision moved": 변경 자체가 stable/frozen 파일에서 일어났으면
   *  durability pre-filter를 건너뛰고 모든 durability의 referencing 파일을
   *  대상에 포함한다. 변경이 volatile이면(가장 흔한 경우) stable/frozen
   *  referencing 파일은 제외한다. */
  changeOriginatesInDurablePartition: boolean;
}

/**
 * changedSymbolIds(Phase A가 판정한, signature_hash가 바뀌었거나/새로
 * 생겼거나/사라진 심볼들)를 참조하는 파일들의 **경로** 집합을 반환한다.
 * 결과는 durability pre-filter를 이미 통과한 상태 — resolve.ts의
 * `scopeFilePaths`에 바로 넘길 수 있다. changedSymbolIds가 비어 있으면
 * 쿼리조차 나가지 않고 빈 집합을 반환한다.
 */
export async function findAffectedFilePaths(
  dataSource: DataSource,
  graphId: string,
  changedSymbolIds: readonly string[],
  opts: FindAffectedFilesOptions,
): Promise<Set<string>> {
  if (changedSymbolIds.length === 0) return new Set();

  const reverseRepo = dataSource.getRepository(OntologyReverseEdgeIndex);
  const symbolIds = [...changedSymbolIds];
  const reverseRows: OntologyReverseEdgeIndex[] = [];
  for (let i = 0; i < symbolIds.length; i += ID_CHUNK_SIZE) {
    const chunk = symbolIds.slice(i, i + ID_CHUNK_SIZE);
    reverseRows.push(...(await reverseRepo.find({ where: { graph_id: graphId, dst_symbol_id: In(chunk) } })));
  }
  if (reverseRows.length === 0) return new Set();

  const fileIds = [...new Set(reverseRows.map((r) => r.src_file_id))];
  const nodeRepo = dataSource.getRepository(OntologyNode);
  const fileNodes: Array<Pick<OntologyNode, 'id' | 'path' | 'durability'>> = [];
  for (let i = 0; i < fileIds.length; i += ID_CHUNK_SIZE) {
    const chunk = fileIds.slice(i, i + ID_CHUNK_SIZE);
    fileNodes.push(
      ...(await nodeRepo.find({
        where: { graph_id: graphId, id: In(chunk), status: 'active' },
        select: ['id', 'path', 'durability'],
      })),
    );
  }

  const out = new Set<string>();
  for (const f of fileNodes) {
    if (!opts.changeOriginatesInDurablePartition && (f.durability === 'stable' || f.durability === 'frozen')) continue;
    out.add(f.path);
  }
  return out;
}
