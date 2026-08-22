// 최소 NestJS 인식 @ast-grep/napi 룰셋 (ticket e14ef1c9, DESIGN.md 축 1
// Integration points + REVIEW-NOTES.md I6). guards/interceptors/pipes/
// @Cron()/@EventPattern() — reflect-metadata로 프레임워크가 호출하는,
// tree-sitter tags 쿼리로는 절대 보이지 않는 디스패치. DECORATES 엣지는
// Tier 1.5 이름 해석 캐스케이드를 전혀 쓰지 않는 별도의, 상수 신뢰도
// (confidence≈0.6, method='constant', resolution='dynamic') 룰이라 여기
// 단독으로도 완결된다 — optional/non-blocking, 쿼리 가능성 자체는 이
// 룰셋에 의존하지 않는다.
//
// ast-grep은 web-tree-sitter/tree-sitter-wasms와 별개의 자체 번들 TypeScript
// 문법을 쓴다(@ast-grep/napi@0.45.1) — 트리 모양이 다를 수 있어 실제로 직접
// 파싱해 검증했다: 데코레이터는 데코레이트 대상 노드의 자식이 아니라
// **형제**다 — 클래스
// 데코레이터는 export_statement의 형제(그 안에 class_declaration이 별도
// 자식으로 있음), 메서드 데코레이터는 class_body 안에서 method_definition의
// 앞선 형제. 조상으로 걸어 올라가는 방식은 클래스 레벨 데코레이터를 못 찾고
// 메서드 데코레이터는 엉뚱하게 감싸는 클래스로 잘못 귀속된다 — 반드시 형제
// 탐색이어야 한다.
import { Lang, parse, type SgNode } from '@ast-grep/napi';
import type { ExtractionLang } from './types';

export type DecoratorFamily = 'guard' | 'interceptor' | 'pipe' | 'cron' | 'event_pattern';
export type DecoratedTargetKind = 'class' | 'method' | 'field';

export interface DecoratorFact {
  family: DecoratorFamily;
  /** 데코레이트된 대상의 종류 — extract-file.ts의 DefFact와 조인할 때 쓴다. */
  targetKind: DecoratedTargetKind;
  targetName: string;
  targetStartLine: number;
  targetEndLine: number;
  /** guard/interceptor/pipe: 데코레이터 인자로 쓰인 식별자들(클래스 이름으로
   *  추정) — persist 단계가 같은 그래프 안에서 이름으로 찾아 DECORATES
   *  엣지를 만든다. cron/event_pattern은 항상 빈 배열(인자가 문자열
   *  리터럴이라 식별자 타깃이 없음). */
  argIdentifiers: string[];
}

const FAMILY_PATTERNS: Array<{ family: DecoratorFamily; pattern: string }> = [
  { family: 'guard', pattern: '@UseGuards($$$ARGS)' },
  { family: 'interceptor', pattern: '@UseInterceptors($$$ARGS)' },
  { family: 'pipe', pattern: '@UsePipes($$$ARGS)' },
  { family: 'cron', pattern: '@Cron($$$ARGS)' },
  { family: 'event_pattern', pattern: '@EventPattern($$$ARGS)' },
];

const DECL_KIND_MAP: Record<string, DecoratedTargetKind> = {
  class_declaration: 'class',
  method_definition: 'method',
  public_field_definition: 'field',
  field_definition: 'field', // 순수 javascript 문법(tag-queries/javascript.ts와 같은 자매 구분)
};
const DECL_KINDS = new Set(Object.keys(DECL_KIND_MAP));

function astGrepLang(lang: ExtractionLang): Lang {
  if (lang === 'tsx') return Lang.Tsx;
  if (lang === 'javascript') return Lang.JavaScript;
  return Lang.TypeScript;
}

/** 데코레이터 노드로부터 그것이 실제로 데코레이트하는 선언 노드를 찾는다.
 *  ast-grep의 TS 문법에서 데코레이터는 대상의 자식이 아니라 형제다(위
 *  헤더 코멘트) — 부모의 children()에서 자기 다음 위치부터 스캔해, 겹쳐
 *  쌓인 다른 데코레이터는 건너뛰고 첫 선언 노드(또는 export_statement에
 *  감싸인 class_declaration)를 찾는다. */
function findDecoratedTarget(decoratorNode: SgNode): SgNode | null {
  const parent = decoratorNode.parent();
  if (!parent) return null;
  const siblings = parent.children();
  const idx = siblings.findIndex((s) => s.id() === decoratorNode.id());
  if (idx < 0) return null;
  for (let i = idx + 1; i < siblings.length; i++) {
    const s = siblings[i];
    if (s.kind() === 'decorator') continue;
    if (DECL_KINDS.has(String(s.kind()))) return s;
    if (s.kind() === 'export_statement') {
      const inner = s.children().find((c) => DECL_KINDS.has(String(c.kind())));
      if (inner) return inner;
    }
    if (s.isNamed()) break; // 예상 밖 형태 — 더 스캔해도 못 찾을 가능성이 높다
  }
  return null;
}

/** 파일 하나에서 NestJS 프레임워크 리플렉션 데코레이터 사실을 뽑는다 —
 *  extract-file.ts와 완전히 독립적인 별도 파서 패스(ast-grep 자체 번들
 *  문법). 다른 파일 상태를 읽지 않는다 — Tier 1의 단일 파일 불변식은
 *  그대로 유지. */
export function extractDecoratorFacts(path: string, content: string, lang: ExtractionLang): DecoratorFact[] {
  if (lang === 'javascript') return []; // NestJS 데코레이터는 TS 전용 관례
  let root;
  try {
    root = parse(astGrepLang(lang), content).root();
  } catch {
    return []; // 파싱 실패는 tree-sitter 패스가 이미 hasParseError로 보고 — 여기선 조용히 스킵
  }

  const facts: DecoratorFact[] = [];
  for (const { family, pattern } of FAMILY_PATTERNS) {
    let matches: SgNode[];
    try {
      matches = root.findAll(pattern);
    } catch {
      continue;
    }
    for (const m of matches) {
      const target = findDecoratedTarget(m);
      if (!target) continue;
      const targetKind = DECL_KIND_MAP[String(target.kind())];
      const nameField = target.field('name');
      const targetName = nameField ? nameField.text() : '';
      if (!targetName) continue;
      const range = target.range();
      const argIdentifiers =
        family === 'cron' || family === 'event_pattern'
          ? []
          : m.getMultipleMatches('ARGS').filter((a) => a.kind() === 'identifier').map((a) => a.text());
      facts.push({
        family,
        targetKind,
        targetName,
        targetStartLine: range.start.line + 1,
        targetEndLine: range.end.line + 1,
        argIdentifiers,
      });
    }
  }
  return facts;
}
