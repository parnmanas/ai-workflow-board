import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { tokens } from './tokens';

// Inject global keyframes + AppLayout responsive sidebar CSS
const style = document.createElement('style');
style.textContent = `
  @keyframes dotPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  /* AppLayout responsive sidebar (D-12 / UI-SPEC) */
  .awb-shell {
    display: flex;
    min-height: 100vh;
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
    overflow: auto;
  }
  .awb-sidebar-backdrop { display: none; }
  .awb-topbar { display: none; }

  @media (max-width: 767px) {
    .awb-sidebar {
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
    .awb-sidebar.awb-sidebar--open {
      transform: translateX(0);
      box-shadow: 4px 0 20px rgba(0, 0, 0, 0.5);
    }
    .awb-sidebar-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
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
    }
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
