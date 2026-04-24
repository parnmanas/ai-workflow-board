import { useEffect, RefObject } from 'react';

type Axis = 'x' | 'y' | 'both';

export interface UseDragToScrollOptions {
  axis?: Axis;
  threshold?: number;
}

export function useDragToScroll<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: UseDragToScrollOptions = {},
): void {
  const { axis = 'both', threshold = 3 } = options;

  useEffect(() => {
    const el = ref.current;
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
      // If a nested useDragToScroll container already handled this event, skip
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
  }, [ref, axis, threshold]);
}
