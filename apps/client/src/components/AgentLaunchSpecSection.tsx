import React, { useMemo, useState } from 'react';
import type { AgentLaunchSpecEntry, LaunchArgEntry, LaunchEnvEntry } from '../types';
import { tokens } from '../tokens';

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
  runtime_profile: '런타임 프로파일',
  unattributed: '출처 불명',
};

const SOURCE_COLOR: Record<LaunchArgEntry['source'], string> = {
  adapter: tokens.colors.textMuted,
  model: tokens.colors.accent,
  permission: tokens.colors.warning,
  mcp: tokens.colors.textSecondary,
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
  const [copied, setCopied] = useState(false);

  // 복사용 한 줄. 값은 이미 마스킹된 상태라 그대로 이어 붙인다 — 공백이 든
  // 토큰만 따옴표로 감싸 셸에 붙여 넣었을 때 토큰 경계가 유지되게 한다.
  const commandLine = useMemo(() => {
    if (!spec) return '';
    const quote = (v: string) => (/\s/.test(v) ? JSON.stringify(v) : v);
    return [spec.bin ?? `<${spec.cli} 실행 파일 미해석>`, ...spec.args.map((a) => quote(a.value))].join(' ');
  }, [spec]);

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

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(commandLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary }}>
                  실행 명령
                </span>
                <button
                  type="button"
                  onClick={copy}
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
                  {copied ? '복사됨' : '복사'}
                </button>
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
                {spec.args.map((arg, i) => (
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
              <div style={{ color: tokens.colors.textMuted }}>작업 폴더</div>
              <div><Value value={spec.cwd} /></div>
              <div style={{ color: tokens.colors.textMuted }}>MCP 설정</div>
              <div><Value value={spec.mcp_config_path} /></div>
              <div style={{ color: tokens.colors.textMuted }}>모델</div>
              <div><Value value={spec.model} empty="(CLI 기본값)" /></div>
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
