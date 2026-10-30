// src/liveDashboard/Pager.tsx
//
// Horizontal pages for the web Live Dashboard (Overview → Running lines). Swipe (touch, pen or mouse
// drag) follows the finger and snaps to the next page past a threshold;
// ←/→ keys and the header tabs switch too. A vertical drag is left alone.

import React, { useEffect, useRef, useState } from 'react';

const THRESHOLD_PX = 70;

export default function Pager({ index, onIndex, pages }: { index: number; onIndex: (i: number) => void; pages: React.ReactNode[] }) {
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null);
  const last = pages.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1));
      if (e.key === 'ArrowRight') onIndex(Math.min(last, index + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, last, onIndex]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (d.horizontal == null && Math.hypot(mx, my) > 8) {
      d.horizontal = Math.abs(mx) > Math.abs(my);
      if (d.horizontal) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    if (!d.horizontal) return;
    // Resist past the first / last page.
    const edge = (index === 0 && mx > 0) || (index === last && mx < 0);
    setDx(edge ? mx / 4 : mx);
  };
  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !d.horizontal) return;
    const mx = e.clientX - d.x;
    setDx(0);
    // Dragging right reveals the page on the left, and vice versa.
    if (mx > THRESHOLD_PX && index > 0) onIndex(index - 1);
    else if (mx < -THRESHOLD_PX && index < last) onIndex(index + 1);
  };

  return (
    <div className={`ld-pager${dx ? ' is-dragging' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end}>
      <div className="ld-track" style={{ transform: `translate3d(calc(${-index * 100}% + ${dx}px), 0, 0)` }}>
        {pages.map((p, i) => (
          <div key={i} className="ld-page" aria-hidden={i !== index} inert={i !== index}>
            {p}
          </div>
        ))}
      </div>
      <div className="ld-pagedots" aria-hidden="true">
        {pages.map((_, i) => <i key={i} className={i === index ? 'is-on' : ''} />)}
      </div>
    </div>
  );
}
