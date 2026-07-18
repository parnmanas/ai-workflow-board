import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { tokens } from './tokens';

// Inject global keyframes + AppLayout responsive sidebar CSS
const style = document.createElement('style');
style.textContent = `
  /* 문서 배경/기본 텍스트의 권위 원천은 토큰이다(F2-2). index.html 의 인라인
     body 규칙은 번들 로드 전 flash 방지용 fallback 이며 이 값과 미러링한다. */
  body { background: ${tokens.colors.surface}; color: ${tokens.colors.textStrong}; }

  @keyframes dotPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  /* Ticket pending-user-action badge pulse (ticket a57517be).
     Subtle background flash so the badge catches the eye without becoming
     distracting on a board with multiple parked tickets. */
  @keyframes awb-pending-pulse {
    0%, 100% { box-shadow: 0 0 0 0 ${tokens.colors.warning}80; transform: scale(1); }
    50%      { box-shadow: 0 0 0 4px ${tokens.colors.warning}00; transform: scale(1.04); }
  }
  .awb-pending-pulse { animation: awb-pending-pulse 1.8s ease-in-out infinite; }

  /* AppLayout responsive sidebar (D-12 / UI-SPEC) */
  .awb-shell {
    display: flex;
    height: 100vh;
    overflow: hidden;
    background: ${tokens.colors.surface};
  }
  .awb-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .awb-content {
    flex: 1;
    overflow-y: auto;
  }
  /* Off-canvas(드로어) 사이드바 — 모바일 상시 + 데스크톱 Chat-first (에픽 bf65ca00 S1).
     AppLayout 이 drawerMode 일 때 .awb-sidebar--overlay 를 부여하므로 미디어쿼리에
     의존하지 않고 데스크톱에서도 동일한 햄버거 드로어를 재사용한다. Advanced 데스크톱은
     이 클래스가 없어 기존 상시 사이드바 그대로다. */
  .awb-sidebar--overlay {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 220px;
    z-index: 1100;
    transform: translateX(-100%);
    transition: transform 200ms ease-out;
    box-shadow: none;
  }
  .awb-sidebar--overlay.awb-sidebar--open {
    transform: translateX(0);
    box-shadow: 4px 0 20px rgba(0, 0, 0, 0.5);
  }
  /* backdrop / topbar 는 drawerMode 에서만 JSX 로 렌더되므로 기본 display 를 노출로 둔다. */
  .awb-sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: ${tokens.overlays.backdropSoft};
    z-index: 1099;
  }
  .awb-topbar {
    display: flex;
    align-items: center;
    padding: 0 16px;
    height: 48px;
    background: ${tokens.colors.surfaceCard};
    border-bottom: 1px solid ${tokens.colors.border};
    gap: 12px;
    flex-shrink: 0;
  }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
