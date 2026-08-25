// 그래프 하나(graph_id)의 노드/DECLARES 엣지를 메모리로 읽어 리졸버가 쓸
// 조회 인덱스로 만든다(ticket e52e7f64, DESIGN.md 축 1 "Tier 1.5는
// separate, whole-workspace pass"). persist.ts(ticket e14ef1c9)가 File
// 노드 props에 남겨둔 refs[]/imports[]/exports[]/heritage[]를 재파싱 없이
// 그대로 읽어들인다 — persist.ts 자신의 헤더 코멘트가 명시한 계약.
import type { DataSource, EntityManager } from 'typeorm';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyEdge } from '../../../entities/OntologyEdge';
import type { ExportFact, HeritageFact, ImportFact, RefFact } from '../extraction/types';
import { BKTree } from './bk-tree';

export interface FileFacts {
  refs: RefFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  heritage: HeritageFact[];
}

export interface FileNodeInfo {
  id: string;
  symbolId: string;
  path: string;
  facts: FileFacts;
}

export interface DefNodeInfo {
  id: string;
  symbolId: string;
  name: string;
  qualifiedName: string;
  /** OntologyNode.kind — class/interface/function/method/type/enum/field/variable. */
  kind: string;
  /** OntologyNode.type — Type/Callable/Field 중 하나(DEF_KIND_TO_NODE_TYPE, persist.ts). */
  type: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
}

/** 그래프 하나의 whole-workspace 심볼 인덱스 — 파일 경로/이름/한정이름/
 *  BK-tree 조회를 위한 자료구조를 한 번의 DB 스캔으로 구성한다. */
export class GraphSymbolIndex {
  readonly filesByPath = new Map<string, FileNodeInfo>();
  readonly allFilePaths: string[] = [];
  readonly defsByFilePath = new Map<string, DefNodeInfo[]>();
  readonly defsByName = new Map<string, DefNodeInfo[]>();
  /** DECLARES 엣지의 src(부모 def/클래스 노드 id) -> 자식 def 목록 —
   *  클래스 멤버 조회(qualifier-aware ref 해소, OVERRIDES 파생) 전용. */
  readonly membersByContainerId = new Map<string, DefNodeInfo[]>();
  readonly nodeById = new Map<string, DefNodeInfo | FileNodeInfo>();
  readonly bkTree = new BKTree();

  addFile(info: FileNodeInfo): void {
    this.filesByPath.set(info.path, info);
    this.allFilePaths.push(info.path);
    this.nodeById.set(info.id, info);
  }

  addDef(info: DefNodeInfo): void {
    this.nodeById.set(info.id, info);
    const byFile = this.defsByFilePath.get(info.path) ?? [];
    byFile.push(info);
    this.defsByFilePath.set(info.path, byFile);
    const byName = this.defsByName.get(info.name) ?? [];
    byName.push(info);
    this.defsByName.set(info.name, byName);
    if (byName.length === 1) this.bkTree.insert(info.name); // 이름당 한 번만 트리에 삽입 — 중복 노드로 트리를 불리지 않는다
  }

  addDeclaresMember(containerId: string, member: DefNodeInfo): void {
    const list = this.membersByContainerId.get(containerId) ?? [];
    list.push(member);
    this.membersByContainerId.set(containerId, list);
  }
}

const DEF_NODE_TYPES = new Set(['Type', 'Callable', 'Field']);

export async function buildGraphSymbolIndex(dataSource: DataSource | EntityManager, graphId: string): Promise<GraphSymbolIndex> {
  const nodeRepo = dataSource.getRepository(OntologyNode);
  const edgeRepo = dataSource.getRepository(OntologyEdge);
  // status='active'로 제한 — removed/quarantined 노드를 리졸버 입력에
  // 포함하면 이미 지워진 심볼이 계속 멤버/해소 대상으로 취급된다(리뷰
  // 지적 라운드 2).
  const nodes = await nodeRepo.find({ where: { graph_id: graphId, status: 'active' } });

  const index = new GraphSymbolIndex();
  const defNodeById = new Map<string, DefNodeInfo>();

  for (const n of nodes) {
    if (n.type === 'File') {
      const props = JSON.parse(n.props || '{}');
      index.addFile({
        id: n.id,
        symbolId: n.symbol_id,
        path: n.path,
        facts: {
          refs: props.refs ?? [],
          imports: props.imports ?? [],
          exports: props.exports ?? [],
          heritage: props.heritage ?? [],
        },
      });
      continue;
    }
    if (DEF_NODE_TYPES.has(n.type)) {
      const info: DefNodeInfo = {
        id: n.id,
        symbolId: n.symbol_id,
        name: n.name,
        qualifiedName: n.qualified_name,
        kind: n.kind,
        type: n.type,
        path: n.path,
        startLine: n.start_line,
        endLine: n.end_line,
      };
      defNodeById.set(n.id, info);
      index.addDef(info);
    }
  }

  const declaresEdges = await edgeRepo.find({ where: { graph_id: graphId, type: 'DECLARES', status: 'active' } });
  for (const e of declaresEdges) {
    const member = defNodeById.get(e.dst_id);
    if (member) index.addDeclaresMember(e.src_id, member);
  }

  return index;
}
