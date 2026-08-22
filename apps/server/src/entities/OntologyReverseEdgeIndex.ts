import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// 역방향 참조 색인(ticket e52e7f64, DESIGN.md 축 1/4 —
// research-incremental.md §3, §4.2 Phase B) — "이 심볼(dst_symbol_id)을
// 참조하는 파일(src_file_id)은 어디인가"를 단일 인덱스 조회로 답하기 위한
// 전용 협소 테이블. OntologyEdge의 (graph_id, dst_id, type) 인덱스로도
// 유도 가능하지만, 증분 갱신(ticket #4, 미배정)의 Phase B 핫 경로가 매
// 저장마다 훑는 질의라 별도 테이블로 존재한다 — research-incremental.md
// §3 원문: "a materialized reverse_edge_index(dst_symbol_id, src_file_id)
// table (derivable from the existing edge table's (graph_id, dst_id, type)
// index, but worth a dedicated narrow table for the hot Phase-B lookup
// path)".
//
// dst는 symbol_id(그래프 스코프의 안정적 식별자, OntologyNode.symbol_id)로
// 키잉하지만 src_file_id는 File 노드의 내부 id(uuid, OntologyNode.id)다 —
// 이 비대칭은 설계 문서 원문의 컬럼명을 그대로 따른 것이다
// (`reverse_edge_index(dst_symbol_id, src_file_id)`, symbol_id가 아니라
// _id). dst 쪽이 symbol_id인 이유는 이 색인의 존재 이유 자체가 "증분
// 재추출 후에도 안정적으로 남는 식별자로, 방금 바뀐 심볼을 참조하는
// 파일을 찾는 것"이기 때문 — src 쪽까지 symbol_id로 바꾸는 재설계는 이
// 티켓 범위 밖(증분 재추출 간 File 노드 uuid 안정성 보장은 ticket #4의
// 몫이며, 그 티켓이 필요하면 File 노드 자신의 symbol_id 컬럼을 통해 join할
// 수 있다).
//
// STORAGE: OntologyNode/OntologyEdge와 같은 자세 — sql.js에서는
// buildOntologyDataSourceOptions()의 독립 DataSource, Postgres에서는 기존
// 단일 DataSource(db.ts 참고).
@Index(['graph_id', 'dst_symbol_id'])
@Entity('ontology_reverse_edge_index')
export class OntologyReverseEdgeIndex {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  graph_id: string;

  @Column({ type: 'varchar' })
  dst_symbol_id: string;

  @Column({ type: 'varchar' })
  src_file_id: string;

  // 파생 색인 행은 불변(추출 런마다 재계산) — RelationTuple.ts와 같은
  // 자세로 updated_at을 두지 않는다.
  @CreateDateColumn()
  created_at: Date;
}
