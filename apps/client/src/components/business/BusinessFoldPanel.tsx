import React, { useCallback, useState } from 'react';
import { t } from '../../i18n/core';
import { type BusinessFoldKey, isBusinessFolded, readBusinessFold, withBusinessFold, writeBusinessFold } from './businessFold.logic';

/** 업무 상세의 접을 수 있는 섹션. 접힘은 섹션 키 단위로 localStorage 에 남는다(businessFold.logic.ts). */
export function BusinessFoldPanel({ id, title, badge, controls, className, children }: {
  id: BusinessFoldKey;
  /** 제목(이미 번역된 글). `aria-label` 과 heading 양쪽에 쓴다. */
  title: string;
  /** 제목 옆 수(열린 요청 수 · 메시지 수). 접혀 있어도 보인다 — 펼칠지 판단할 근거다. */
  badge?: React.ReactNode;
  /** 펼쳤을 때만 heading 줄에 보이는 조작(기록 필터 등). */
  controls?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [folded, setFolded] = useState(() => isBusinessFolded(readBusinessFold(), id));
  const toggle = useCallback(() => {
    setFolded(current => {
      const next = !current;
      // 다른 탭 · 다른 업무에서 바꾼 값을 덮지 않도록 저장본을 다시 읽어 그 위에 쓴다.
      writeBusinessFold(withBusinessFold(readBusinessFold(), id, next));
      return next;
    });
  }, [id]);
  const bodyId = `business-fold-${id}`;
  return <section className={`business-panel business-fold${folded ? ' folded' : ''}${className ? ` ${className}` : ''}`} aria-label={title}>
    <div className="business-section-heading business-fold-heading">
      <h2>
        <button type="button" className="business-fold-toggle" aria-expanded={!folded} aria-controls={bodyId} onClick={toggle} title={folded ? t('펼치기') : t('접기')}>
          <span className="business-fold-chevron" aria-hidden="true">{folded ? '▸' : '▾'}</span>
          <span>{title}</span>
          {badge !== undefined && badge !== null && <span className="business-count">{badge}</span>}
          <span className="business-fold-state">{folded ? t('펼치기') : t('접기')}</span>
        </button>
      </h2>
      {!folded && controls}
    </div>
    {!folded && <div id={bodyId} className="business-fold-body">{children}</div>}
  </section>;
}
