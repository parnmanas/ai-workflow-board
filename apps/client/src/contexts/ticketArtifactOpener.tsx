import React, { createContext, useContext } from 'react';

/**
 * 티켓 Artifact 오프너 컨텍스트 (에픽 bf65ca00 · Phase 1 · S2/S3).
 *
 * 채팅/코멘트의 `@[ticket:<id>|title]` 카드(TicketRefCard)가 클릭 시 우측 Artifact
 * 패널에 티켓 상세를 여는 단일 진입점이다. 순수 렌더 유틸(chat/utils/markdown.tsx)이
 * api·TicketArtifact 를 트랜지티브하게 끌어오지 않도록, 카드는 이 컨텍스트의 얇은
 * 오프너만 소비한다. 기본값은 no-op 이라 프로바이더 밖(SSR 계약 테스트 등)에서도
 * throw 없이 렌더된다 — 실제 패널 구동 로직은 셸의 TicketArtifactController 가 주입한다.
 *
 * F-1(구조화 카드 계약)이 붙어도 카드→패널 오픈 경로는 이 오프너 하나로 유지된다.
 */
export type OpenTicketArtifact = (ticketId: string, title?: string) => void;

const noop: OpenTicketArtifact = () => {};

const TicketArtifactOpenerContext = createContext<OpenTicketArtifact>(noop);

export function TicketArtifactOpenerProvider({
  value,
  children,
}: {
  value: OpenTicketArtifact;
  children: React.ReactNode;
}) {
  return (
    <TicketArtifactOpenerContext.Provider value={value}>
      {children}
    </TicketArtifactOpenerContext.Provider>
  );
}

/** 프로바이더 밖에서는 no-op 을 돌려준다(throw 없음) — 카드가 어느 표면에서도 안전히 렌더. */
export function useOpenTicketArtifact(): OpenTicketArtifact {
  return useContext(TicketArtifactOpenerContext);
}
