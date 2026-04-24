import { useEffect, useState } from 'react';

type Axis = 'x' | 'y' | 'both';

export interface UseDragToScrollOptions {
  axis?: Axis;
  threshold?: number;
}

/**
 * Click-and-drag pan on a scroll container. Returns a callback ref — attach
 * it to the element you want pannable. The hook re-attaches listeners when
 * the element changes, so it survives conditional renders that swap the
 * underlying DOM node (e.g. toggling a side panel that renders a different
 * scroll container subtree).
 */
export function useDragToScroll<T extends HTMLElement>(
  options: UseDragToScrollOptions = {},
): (node: T | null) => void {
  const { axis = 'both', threshold = 3 } = options;
  const [el, setEl] = useState<T | null>(null);

  useEffect(() => {
    if (!el) return;

    let active = false;
    let passedThreshold = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let prevBodyCursor = '';
    let prevBodyUserSelect = '';

    const onMouseMove = (e: MouseEvent) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!passedThreshold) {
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
        passedThreshold = true;
        prevBodyCursor = document.body.style.cursor;
        prevBodyUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }

      if (axis === 'x' || axis === 'both') {
        el.scrollLeft = startScrollLeft - dx;
      }
      if (axis === 'y' || axis === 'both') {
        el.scrollTop = startScrollTop - dy;
      }
    };

    const onMouseUp = () => {
      if (!active) return;
      active = false;
      if (passedThreshold) {
        document.body.style.cursor = prevBodyCursor;
        document.body.style.userSelect = prevBodyUserSelect;
      }
      passedThreshold = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // @hello-pangea/dnd owns mousedown on draggable cards
      if (target.closest('[data-rfd-draggable-id]')) return;
      // Let interactive controls handle their own mousedowns
      if (target.closest('button, a, input, textarea, select, label, [contenteditable="true"]')) return;
      if (!el.contains(target)) return;
      // Inner container wins over outer when nested
      e.stopPropagation();
      active = true;
      passedThreshold = false;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = el.scrollLeft;
      startScrollTop = el.scrollTop;
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    };

    el.addEventListener('mousedown', onMouseDown);

    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (passedThreshold) {
        document.body.style.cursor = prevBodyCursor;
        document.body.style.userSelect = prevBodyUserSelect;
      }
    };
  }, [el, axis, threshold]);

  return setEl;
}
