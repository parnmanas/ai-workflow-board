import React, { useMemo, useState } from 'react';
import type { AgentLaunchSpecEntry, LaunchArgEntry, LaunchEnvEntry, LaunchModeSpec } from '../types';
import { tokens } from '../tokens';
import { posixCommandLine, argvJson } from '../utils/shellQuote';

/**
 * "실행 인자" 섹션 — 이 에이전트가 다음에 spawn 될 때 실제로 받는 실행 파일과
 * argv 를 출처와 함께 보여준다 (ticket 20fff298).
 *
 * ## 왜 상태를 네 갈래로 나누는가
 *
 * 요구사항 C 의 핵심은 **"매니저가 보고하지 않음" / "값 없음" / "0·false" 를
 * 뭉개지 말라**는 것이다. 여기서 그 구분이 가장 뚜렷하게 필요하다:
 *
 *   - 소유 매니저를 못 찾음      → 알 수 없음 (매니저가 죽었거나 아직 heartbeat 전)
 *   - 매니저는 있는데 필드 부재  → 구버전 매니저 (업데이트하면 보인다)
 *   - 필드는 있는데 이 에이전트 행이 없음 → 매니저가 이 에이전트를 감독하지 않음
 *   - 행 있음                    → 실제 사양
 *
 * 넷을 "정보 없음" 하나로 접으면 운영자는 매니저를 업데이트해야 하는지, 에이전트
 * 배선이 틀린 건지, 그냥 아직 안 온 건지 구분할 수 없다 — 그게 이 티켓이 고치려는
 * "틀린 정보로 읽히는" 표시다.
 *
 * ## 값은 이미 마스킹되어 온다
 *
 * `value` 는 매니저가 spawn 로그와 같은 규칙으로 접어 보낸 표시용 문자열이다.
 * 이 컴포넌트는 마스킹을 하지도, 풀지도 않는다.
 */

const SOURCE_LABEL: Record<LaunchArgEntry['source'], string> = {
  adapter: '어댑터 기본값',
  model: '모델 설정',
  permission: 'trust·권한 설정',
  mcp: 'MCP 설정',
  session: '세션 식별자',
  runtime_profile: '런타임 프로파일',
  unattributed: '출처 불명',
};

/** spawn 경로 라벨. 어느 쪽이 실제로 도는 경로인지가 이 화면에서 가장 헷갈리는
 *  지점이라, 이름만 쓰지 않고 무엇인지 함께 적는다. */
const MODE_LABEL: Record<LaunchModeSpec['mode'], string> = {
  session: '지속 세션',
  oneshot: '일회성 실행',
};

const MODE_HINT: Record<LaunchModeSpec['mode'], string> = {
  session: '티켓·채팅 디스패치의 기본 경로입니다. 프로세스가 살아 있는 동안 여러 턴을 처리합니다.',
  oneshot: '한 번 실행하고 끝나는 경로입니다. 지속 세션을 지원하지 않는 CLI 나 꺼 둔 경우에 쓰입니다.',
};

const MODE_LABEL_ACTUAL: Record<LaunchModeSpec['mode'], string> = {
  session: '지속 세션',
  oneshot: '일회성 실행',
};

const SOURCE_COLOR: Record<LaunchArgEntry['source'], string> = {
  adapter: tokens.colors.textMuted,
  model: tokens.colors.accent,
  permission: tokens.colors.warning,
  mcp: tokens.colors.textSecondary,
  session: tokens.colors.textSecondary,
  runtime_profile: tokens.colors.success,
  unattributed: tokens.colors.danger,
};

/** env 항목의 출처는 argv 출처와 집합이 다르다 — 같은 맵을 재사용하면
 *  `cli_home` 이 조용히 undefined 로 떨어져 배지가 빈칸이 된다. */
const ENV_SOURCE_LABEL: Record<LaunchEnvEntry['source'], string> = {
  cli_home: 'CLI 홈 격리',
  credential: '자격증명',
  runtime_profile: '런타임 프로파일',
};

const ENV_SOURCE_COLOR: Record<LaunchEnvEntry['source'], string> = {
  cli_home: tokens.colors.textMuted,
  credential: tokens.colors.accent,
  runtime_profile: tokens.colors.success,
};

const PERMISSION_SOURCE_LABEL: Record<string, string> = {
  agent_trust: '에이전트 trust 설정',
  harness: '보드·워크스페이스 하네스',
  invalid_trust: 'trust 값이 잘못되어 최소 권한으로 강등',
  default: '매니저 기본값 (trust 미설정)',
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export interface AgentLaunchSpecSectionProps {
  /** 이 에이전트의 사양. 매니저가 보고했지만 이 에이전트 행이 없으면 null. */
  spec: AgentLaunchSpecEntry | null;
  /** 소유 매니저를 찾았는가. false 면 매니저 자체가 오프라인/미지정이다. */
  managerFound: boolean;
  /** 매니저가 `agent_launch_specs` 필드를 보고했는가. 구버전 매니저는 false. */
  reported: boolean;
}

/** 값 없음과 0/false 를 뭉개지 않고 그리는 헬퍼. */
function Value({ value, empty = '(설정 없음)' }: { value: string | null | undefined; empty?: string }) {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: tokens.colors.textMuted }}>{empty}</span>;
  }
  return <span style={{ fontFamily: MONO, wordBreak: 'break-all' }}>{value}</span>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: tokens.colors.textMuted, fontSize: 12, lineHeight: 1.6 }}>{children}</div>
  );
}

export default function AgentLaunchSpecSection({
  spec,
  managerFound,
  reported,
}: AgentLaunchSpecSectionProps) {
  const [copied, setCopied] = useState<'sh' | 'json' | null>(null);
  // 어느 spawn 경로를 보고 있는지. 매니저가 보고한 순서의 첫 항목이 기본
  // 경로이므로 그것을 초깃값으로 쓴다.
  const [modeIndex, setModeIndex] = useState(0);
  const modes = spec?.modes ?? [];
  const activeMode: LaunchModeSpec | null = modes[modeIndex] ?? modes[0] ?? null;

  // 표시·복사용 문자열. **모든 토큰을 POSIX 홑따옴표로 인용한다** (리뷰 2R) —
  // 예전에는 공백이 있을 때만 큰따옴표로 감쌌는데, 그러면 `$(…)`·백틱·`$VAR`·`;`
  // 가 붙여넣는 순간 확장되고, 큰따옴표 안에서는 `$` 가 여전히 살아 있었다.
  // 실행 파일 경로도 인용 대상이다(공백 든 설치 경로가 두 토큰으로 쪼개졌다).
  const binToken = spec?.bin ?? `<${spec?.cli ?? 'cli'} 실행 파일 미해석>`;
  const commandLine = useMemo(
    () => (spec && activeMode ? posixCommandLine(binToken, activeMode.args.map((a) => a.value)) : ''),
    [spec, activeMode, binToken],
  );
  // 기계로 옮길 때의 정답 형태 — 셸 문법이 없어 재해석될 여지가 없다.
  const commandJson = useMemo(
    () => (spec && activeMode ? argvJson(binToken, activeMode.args.map((a) => a.value)) : ''),
    [spec, activeMode, binToken],
  );

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: tokens.colors.textSecondary,
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    marginBottom: 8,
  };
  const cardStyle: React.CSSProperties = {
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: 16,
    color: tokens.colors.textStrong,
    fontSize: 13,
    lineHeight: 1.5,
  };

  const copy = async (text: string, which: 'sh' | 'json') => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // 클립보드 권한이 없으면 아래 <pre> 를 직접 선택해 복사하면 된다.
      // 실패를 토스트로 키우지 않는다 — 대체 경로가 화면에 이미 있다.
    }
  };

  return (
    <section data-testid="launch-spec-section">
      <div style={sectionLabelStyle}>실행 인자</div>
      <div style={cardStyle}>
        {!managerFound ? (
          <Notice>
            소유 매니저를 찾을 수 없어 실행 인자를 확인할 수 없습니다. 매니저가 실행 중이고
            하트비트를 보내고 있는지 확인하세요.
          </Notice>
        ) : !reported ? (
          <Notice>
            이 매니저는 실행 인자를 보고하지 않습니다 — 이 기능을 지원하기 전 버전입니다.
            매니저를 업데이트하면 표시됩니다.
          </Notice>
        ) : !spec ? (
          <Notice>
            이 매니저가 이 에이전트의 실행 인자를 보고하지 않았습니다. 매니저가 현재 이
            에이전트를 감독하고 있지 않을 수 있습니다.
          </Notice>
        ) : spec.modes.length === 0 ? (
          // 사양 행은 왔는데 계산된 spawn 경로가 하나도 없는 경우 — 어댑터가
          // 인자를 만들지 못했다는 뜻이므로 빈 명령을 그리는 대신 사유를 말한다.
          <Notice>
            이 매니저가 이 에이전트의 실행 인자를 계산하지 못했습니다.
            {spec.bin_error ? ` (${spec.bin_error})` : ''}
          </Notice>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {spec.bin_error && (
              <div
                data-testid="launch-spec-bin-error"
                style={{
                  color: tokens.colors.danger,
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                실행 파일을 해석하지 못했습니다: <span style={{ fontFamily: MONO }}>{spec.bin_error}</span>
              </div>
            )}

            {/* 마지막 실제 실행 (ticket 20fff298 리뷰 2R).
                아래 "예상" 은 heartbeat 시점 정보만으로 만든 추정이라 디스패치
                시점 입력(harness / 티켓 effort / 티켓별 프로파일)이 덮는 부분을
                반영하지 못한다. 이 블록은 spawn 사이트가 확정한 값을 그대로
                기록한 것이라, 둘을 나란히 놓으면 무엇이 실제로 달라졌는지 보인다. */}
            {spec.last_spawn && (
              <div data-testid="launch-spec-actual">
                <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 6 }}>
                  마지막 실제 실행
                  <span style={{ fontWeight: 500, color: tokens.colors.textMuted, marginLeft: 6 }}>
                    · {MODE_LABEL_ACTUAL[spec.last_spawn.mode]} · {spec.last_spawn.recorded_at}
                  </span>
                </div>
                <pre
                  data-testid="launch-spec-actual-command"
                  style={{
                    margin: 0,
                    padding: 10,
                    background: tokens.colors.surfaceSubtle,
                    border: `1px solid ${tokens.colors.success}`,
                    borderRadius: tokens.radii.sm,
                    fontFamily: MONO,
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    userSelect: 'text',
                  }}
                >
                  {posixCommandLine(
                    spec.last_spawn.bin ?? '<실행 파일 미기록>',
                    spec.last_spawn.args.map((a) => a.value),
                  )}
                </pre>
                <div style={{ marginTop: 4, fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.6 }}>
                  cwd <span style={{ fontFamily: MONO }}>{spec.last_spawn.cwd ?? '(미기록)'}</span>
                  {spec.last_spawn.context.ticket_id && <> · 티켓 {spec.last_spawn.context.ticket_id.slice(0, 8)}</>}
                  {spec.last_spawn.context.role && <> · 역할 {spec.last_spawn.context.role}</>}
                  {spec.last_spawn.context.effort && <> · effort {spec.last_spawn.context.effort}</>}
                  {spec.last_spawn.context.runtime_profile_id && <> · 프로파일 {spec.last_spawn.context.runtime_profile_id}</>}
                  {spec.last_spawn.context.harness_keys.length > 0 && (
                    <> · harness [{spec.last_spawn.context.harness_keys.join(', ')}]</>
                  )}
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary }}>
              다음 실행 예상
              <span style={{ fontWeight: 500, color: tokens.colors.textMuted, marginLeft: 6 }}>
                · 디스패치 시점 입력은 아직 반영되지 않았습니다
              </span>
            </div>

            {modes.length > 1 && (
              <div data-testid="launch-spec-modes" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {modes.map((m, i) => (
                  <button
                    key={m.mode}
                    type="button"
                    data-mode={m.mode}
                    data-active={i === modeIndex ? 'true' : 'false'}
                    onClick={() => setModeIndex(i)}
                    title={MODE_HINT[m.mode]}
                    style={{
                      padding: '3px 10px',
                      fontSize: 11,
                      fontWeight: 600,
                      background: i === modeIndex ? tokens.colors.surfaceSubtle : 'transparent',
                      color: i === modeIndex ? tokens.colors.textStrong : tokens.colors.textMuted,
                      border: `1px solid ${i === modeIndex ? tokens.colors.accent : tokens.colors.border}`,
                      borderRadius: tokens.radii.sm,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {MODE_LABEL[m.mode]}
                    {i === 0 && <span style={{ marginLeft: 6, fontWeight: 500 }}>{'\u00b7 기본'}</span>}
                  </button>
                ))}
              </div>
            )}

            {activeMode && (
              <Notice>
                <div>{MODE_HINT[activeMode.mode]}</div>
                {/* 매니저가 보낸 경로별 단서. argv 만으로는 드러나지 않는 조건부
                    동작(역할 고정 여부에 따라 MCP 설정 출처가 갈리는 것 등)이라
                    빠뜨리면 운영자가 자리표시자의 이유를 알 수 없다. */}
                {activeMode.notes?.length > 0 && (
                  <ul data-testid="launch-spec-mode-notes" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {activeMode.notes.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                )}
              </Notice>
            )}

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary }}>
                  실행 명령 <span style={{ fontWeight: 500, color: tokens.colors.textMuted }}>(POSIX sh 인용)</span>
                </span>
                {/* 복사 두 갈래 (리뷰 2R): 셸 한 줄은 사람이 읽고 붙여넣는 용도라
                    모든 토큰이 홑따옴표로 인용돼 있고, argv JSON 은 셸 문법이 전혀
                    없어 기계로 옮길 때 재해석 위험이 없다. */}
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  {([
                    ['sh', 'sh 복사', commandLine],
                    ['json', 'argv JSON 복사', commandJson],
                  ] as const).map(([which, label, text]) => (
                    <button
                      key={which}
                      type="button"
                      data-copy={which}
                      onClick={() => copy(text, which)}
                      style={{
                        padding: '3px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        background: 'transparent',
                        color: tokens.colors.textStrong,
                        border: `1px solid ${tokens.colors.border}`,
                        borderRadius: tokens.radii.sm,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {copied === which ? '복사됨' : label}
                    </button>
                  ))}
                </span>
              </div>
              <pre
                data-testid="launch-spec-command"
                style={{
                  margin: 0,
                  padding: 10,
                  background: tokens.colors.surfaceSubtle,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.sm,
                  fontFamily: MONO,
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  userSelect: 'text',
                }}
              >
                {commandLine}
              </pre>
            </div>

            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 6 }}>
                인자별 출처
              </div>
              <ul
                data-testid="launch-spec-args"
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}
              >
                {(activeMode?.args ?? []).map((arg, i) => (
                  <li
                    key={`${i}-${arg.value}`}
                    data-testid="launch-spec-arg"
                    data-source={arg.source}
                    style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontFamily: MONO,
                        wordBreak: 'break-all',
                        color: arg.placeholder ? tokens.colors.textMuted : tokens.colors.textStrong,
                        fontStyle: arg.placeholder ? 'italic' : 'normal',
                      }}
                    >
                      {arg.value}
                    </span>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 10,
                        fontWeight: 600,
                        color: SOURCE_COLOR[arg.source],
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {SOURCE_LABEL[arg.source]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 12, rowGap: 6, fontSize: 12 }}>
              <div style={{ color: tokens.colors.textMuted }}>실행 파일</div>
              <div><Value value={spec.bin} empty="(해석 실패)" /></div>
              <div style={{ color: tokens.colors.textMuted }}>
                {spec.cwd_kind === 'exact' ? '작업 폴더' : '작업 폴더 (기준)'}
              </div>
              {/* base 를 그냥 "작업 폴더"로 쓰면 argv 옆의 경로가 실제 프로세스
                  cwd 로 읽힌다. 티켓 디스패치는 이 아래 티켓별 worktree 에서
                  돌므로 그 사실을 라벨과 툴팁에 남긴다. */}
              <div title={spec.cwd_kind === 'base' ? '티켓 디스패치는 이 폴더 아래 티켓별 worktree 에서 실행됩니다.' : undefined}>
                <Value value={spec.cwd} />
                {spec.cwd_kind === 'base' && (
                  <span style={{ color: tokens.colors.textMuted, marginLeft: 8, fontSize: 11 }}>
                    · 티켓별 worktree 가 이 아래에 생성됩니다
                  </span>
                )}
              </div>
              <div style={{ color: tokens.colors.textMuted }}>MCP 설정</div>
              <div><Value value={spec.mcp_config_path} /></div>
              <div style={{ color: tokens.colors.textMuted }}>모델</div>
              {/* 런타임 프로파일이 활성이면 `--model` 자체가 붙지 않는다 — 프로파일이
                  서빙하는 model 은 raw provider id 라 CLI 가 플래그 값으로 거부하고,
                  실제 라우팅은 ANTHROPIC_MODEL 계열 env 로 간다. "(CLI 기본값)" 만
                  보여 주면 운영자는 어떤 모델이 도는지 알 수 없으므로 함께 적는다. */}
              <div data-testid="launch-spec-model">
                {spec.runtime_profile?.model ? (
                  <>
                    <span style={{ fontFamily: MONO }}>{spec.runtime_profile.model}</span>
                    <span style={{ color: tokens.colors.textMuted, marginLeft: 8, fontSize: 11 }}>
                      · 프로파일이 환경변수로 라우팅 ({'--model'} 플래그는 붙지 않음)
                    </span>
                  </>
                ) : (
                  <Value value={spec.model} empty="(CLI 기본값)" />
                )}
              </div>
              <div style={{ color: tokens.colors.textMuted }}>권한 등급</div>
              <div data-testid="launch-spec-permission">
                <span style={{ fontFamily: MONO }}>{spec.permission.tier}</span>
                <span style={{ color: tokens.colors.textMuted, marginLeft: 8 }}>
                  {PERMISSION_SOURCE_LABEL[spec.permission.source] ?? spec.permission.source}
                </span>
              </div>
              <div style={{ color: tokens.colors.textMuted }}>런타임 프로파일</div>
              <div>
                {spec.runtime_profile ? (
                  <span style={{ fontFamily: MONO }}>
                    {spec.runtime_profile.id} · {spec.runtime_profile.protocol}
                    {spec.runtime_profile.arg_count > 0 && ` · 인자 ${spec.runtime_profile.arg_count}개 추가`}
                  </span>
                ) : (
                  <span style={{ color: tokens.colors.textMuted }}>(적용 안 됨)</span>
                )}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 6 }}>
                환경 변수
              </div>
              {spec.env.length === 0 ? (
                <Notice>이 에이전트에 주입되는 추가 환경 변수가 없습니다.</Notice>
              ) : (
                <ul
                  data-testid="launch-spec-env"
                  style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}
                >
                  {spec.env.map((e) => (
                    <li key={e.key} style={{ display: 'flex', gap: 8, fontSize: 12, fontFamily: MONO }}>
                      <span style={{ color: tokens.colors.textStrong }}>{e.key}</span>
                      <span style={{ color: tokens.colors.textMuted, flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                        {e.value}
                      </span>
                      <span style={{ fontSize: 10, color: ENV_SOURCE_COLOR[e.source], fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                        {ENV_SOURCE_LABEL[e.source]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {spec.varies_per_dispatch.length > 0 && (
              <Notice>
                <div style={{ marginBottom: 4 }}>
                  아래 값은 디스패치 시점에 정해져 이 사양에 반영되어 있지 않습니다:
                </div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {spec.varies_per_dispatch.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
