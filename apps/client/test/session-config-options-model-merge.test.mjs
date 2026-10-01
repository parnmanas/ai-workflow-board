// 세션 안의 모델 드롭다운은 그 순간 연결된 ACP 어댑터의 자기 보고(`live.config_options`)만
// 보여줬다 — 새 세션 대화상자/CLI 설정은 단일 소스(src/cli/hostModels.ts 의
// `useHostModels`)를 거쳐 하트비트·영속 이력·다른 연결의 관측치까지 합친 목록을 보여주므로,
// 같은 host×cli 인데도 "세션 만들 때" 목록과 "세션 안" 목록이 서로 달랐다(갈라진 두 소스).
// 여기서는 세션 화면도 같은 훅과 같은 병합 헬퍼(`withHostModelOption`)를 쓰도록 고정한다 —
// 소스 정규식인 이유는 session-connect-error-visible.test.mjs 와 같다: 실렌더엔
// SSE 컨텍스트·라우팅·여러 api 엔드포인트가 얽혀 있어 배선 자체를 고정하는 편이 더 싸다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/sessions/SessionsPage.tsx', import.meta.url),
  'utf8',
);

test('세션 안 모델 목록도 다른 화면과 같은 단일 소스(hostModels)에서 온다', () => {
  assert.match(source, /import \{ useHostModels, withHostModelOption \} from '\.\.\/\.\.\/cli\/hostModels'/);
  assert.match(source, /const hostModels = useHostModels\(managerId, cli\)/);
  // 어댑터가 보고한 config_options 를 호스트가 아는 모델로 보강한다 — 대체가 아니라 병합.
  assert.match(
    source,
    /const configOptions = useMemo\(\s*\(\) => withHostModelOption\(live\?\.config_options \?\? \[\], hostModels\.models\),/,
  );
});
