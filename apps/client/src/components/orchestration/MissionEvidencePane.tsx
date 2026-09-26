import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { OrchestrationEvidenceItem, OrchestrationStep } from '../../types';
import { relativeTime } from '../../utils/time';
import { EvidenceLightbox, EvidenceThumb, useEvidenceUrls, type EvidenceMediaMeta } from './EvidenceMedia';

/**
 * Evidence 탭 — 미션의 검증 증거(스크린샷·녹화)를 step 별로 모아 보는 갤러리.
 *
 * step 세션은 한 step 의 전부(지시·하트비트·보고·첨부)를 시간순으로 보여주고, 이 탭은
 * 그 반대다: 전 step 의 **미디어만** 한 화면에 모은다. 운영자가 "결과가 실제로 어떻게
 * 보이나"를 확인할 때는 대화를 읽는 게 아니라 그림을 훑는다. 썸네일을 누르면 원본/재생,
 * step 이름을 누르면 그 step 세션으로 건너뛴다(어느 대화 맥락에서 나온 그림인지).
 *
 * 증거는 두 방에서 온다: 담당 agent 가 올리는 step 방(바이트는 orchestration 경로로),
 * 사람·orchestrator 가 올리는 미션 방(바이트는 채팅 경로 — 사람이 그 방의 참여자다).
 */
export default function MissionEvidencePane({
  missionId,
  wsId,
  steps,
  refreshKey,
  onSelectStep,
}: {
  missionId: string;
  wsId: string;
  steps: OrchestrationStep[];
  /** 바뀌면 다시 읽는다 — 미션 상세가 갱신될 때 부모가 올려 준다. */
  refreshKey: string | number;
  onSelectStep: (stepId: string) => void;
}) {
  const [items, setItems] = useState<OrchestrationEvidenceItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ meta: EvidenceMediaMeta; caption: string; url: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listOrchestrationMissionEvidence(missionId, wsId)
      .then((res) => {
        if (alive) {
          setItems(res.items);
          setFailed(null);
        }
      })
      .catch((e: any) => {
        if (alive) setFailed(e?.message || 'Failed to load evidence');
      });
    return () => {
      alive = false;
    };
  }, [missionId, wsId, refreshKey]);

  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const load = useCallback(
    async (meta: EvidenceMediaMeta) => {
      const item = byId.get(meta.id);
      if (!item) return null;
      if (item.step_id) return api.getOrchestrationStepAttachment(item.step_id, wsId, item.id);
      const full = await api.getChatAttachment(item.room_id, item.id);
      return full ? { file_data: full.file_data, mime_type: full.mime_type, truncated: full.truncated } : null;
    },
    [byId, wsId],
  );
  const media = useEvidenceUrls(load);

  if (failed) {
    return <div style={{ fontSize: 12, color: tokens.colors.dangerLight, padding: 16 }}>{failed}</div>;
  }
  if (items === null) {
    return <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: 16 }}>Loading evidence…</div>;
  }
  if (items.length === 0) {
    return (
      <div data-testid="evidence-empty" style={{ fontSize: 12.5, color: tokens.colors.textMuted, padding: 16, lineHeight: 1.7, maxWidth: 640 }}>
        아직 올라온 검증 증거가 없습니다. 담당 agent 는 work order 의 안내대로 자기 step 방에
        스크린샷이나 짧은 녹화를 올리고, 사람은 미션 대화에 첨부할 수 있습니다. 이미지와
        동영상이 여기에 step 별로 모입니다.
      </div>
    );
  }

  // step 순서(position)대로 묶고, 미션 방 항목은 맨 앞에 "Mission" 그룹으로.
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const groups = new Map<string, { title: string; stepId: string | null; items: OrchestrationEvidenceItem[] }>();
  for (const item of items) {
    const key = item.step_id ?? '__mission__';
    if (!groups.has(key)) {
      groups.set(key, {
        title: item.step_id ? `${item.step_title || item.step_key}` : 'Mission conversation',
        stepId: item.step_id,
        items: [],
      });
    }
    groups.get(key)!.items.push(item);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    if (a === '__mission__') return -1;
    if (b === '__mission__') return 1;
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });

  return (
    <div data-testid="evidence-pane" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {ordered.map(([key, group]) => (
        <div key={key} data-testid="evidence-group">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            {group.stepId ? (
              <button
                type="button"
                onClick={() => onSelectStep(group.stepId!)}
                title="이 step 의 작업 세션으로 이동"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  color: tokens.colors.textPrimary,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {group.title} <span style={{ color: tokens.colors.accentSubtle, fontSize: 11 }}>→ session</span>
              </button>
            ) : (
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>{group.title}</span>
            )}
            <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>{group.items.length}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {group.items.map((item) => (
              <figure key={item.id} style={{ margin: 0, width: 150, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <EvidenceThumb
                  meta={item}
                  url={media.urls[item.id]}
                  partial={media.partial[item.id]}
                  onEnsure={media.ensure}
                  onOpen={(meta, url) => setLightbox({ meta, url, caption: `${group.title} · ${item.uploaded_by}` })}
                  size={150}
                />
                <figcaption style={{ fontSize: 10.5, color: tokens.colors.textMuted, lineHeight: 1.4 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.file_name}>
                    {item.file_name}
                  </div>
                  <div>
                    {item.uploaded_by || item.uploaded_by_type} · {relativeTime(item.created_at)}
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      ))}
      {lightbox && (
        <EvidenceLightbox
          meta={lightbox.meta}
          url={lightbox.url}
          caption={lightbox.caption}
          partial={media.partial[lightbox.meta.id]}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
