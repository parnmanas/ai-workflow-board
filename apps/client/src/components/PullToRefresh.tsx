import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { tokens } from '../tokens';

const THRESHOLD = 72;
const SLOP = 10;
const IGNORE = 'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="dialog"], .awb-session-composer, .xterm, canvas, [data-pull-refresh="ignore"]';

function atTop(target: Element, root: HTMLElement): boolean {
  for (let node: Element | null = target; node; node = node.parentElement) {
    // Every scroll container on the touched path must already be at the top.
    // Reaching the top during a normal scroll never starts a refresh.
    if (node.scrollTop > 1) return false;
    if (node === root) return true;
  }
  return false;
}

export default function PullToRefresh({ children, disabled = false, onRefresh = () => window.location.reload() }: {
  children: React.ReactNode;
  disabled?: boolean;
  onRefresh?: () => void;
}) {
  useLocale();
  const rootRef = useRef<HTMLElement>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const location = useLocation();
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || disabled) return;
    let gesture: { id: number; x: number; y: number; target: Element; pulling: boolean } | null = null;
    let pulled = 0;
    let pending = false;
    let frame = 0;
    const reset = () => { gesture = null; pulled = 0; setDistance(0); };
    const start = (event: TouchEvent) => {
      reset();
      if (pending || event.touches.length !== 1 || window.visualViewport && window.visualViewport.scale !== 1) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest(IGNORE) || !atTop(target, root)) return;
      if (window.getSelection()?.toString()) return;
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, target, pulling: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = Array.from(event.touches).find(item => item.identifier === gesture!.id);
      if (!touch || event.touches.length !== 1 || !atTop(gesture.target, root)) { reset(); return; }
      const dx = Math.abs(touch.clientX - gesture.x);
      const dy = touch.clientY - gesture.y;
      if (!gesture.pulling) {
        if (Math.max(dx, Math.abs(dy)) < SLOP) return;
        if (dy <= 0 || dx >= dy) { reset(); return; }
        gesture.pulling = true;
      }
      if (!event.cancelable) { reset(); return; }
      event.preventDefault();
      pulled = Math.min(THRESHOLD + 24, Math.max(0, dy - SLOP) * 0.5);
      setDistance(pulled);
    };
    const end = () => {
      const ready = gesture && pulled >= THRESHOLD;
      reset();
      if (!ready || pending) return;
      pending = true;
      setRefreshing(true);
      // Let the loading indicator paint before reloading this exact URL.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => refreshRef.current()); });
    };
    const cancel = () => reset();
    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end);
    root.addEventListener('touchcancel', cancel);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('touchstart', start);
      root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', end);
      root.removeEventListener('touchcancel', cancel);
      setDistance(0);
      setRefreshing(false);
    };
  }, [disabled, location.pathname, location.search, location.hash]);

  return <>
    <main ref={rootRef} className="awb-content awb-pull-refresh">
      {children}
    </main>
    {(distance > 0 || refreshing) && <div className="awb-refresh-indicator" role="status" style={{
      transform: `translate(-50%, ${refreshing ? 16 : Math.max(0, distance - 32)}px)`,
      background: tokens.colors.surfaceCard, color: tokens.colors.textPrimary,
      border: `1px solid ${tokens.colors.border}`,
    }}>
      <span aria-hidden="true" className={refreshing ? 'awb-refresh-spinner' : undefined}>↻</span>
      {refreshing ? translate('Refreshing…') : distance >= THRESHOLD ? translate('Release to refresh') : translate('Pull down to refresh')}
    </div>}
  </>;
}
