// src/liveDashboard/charts.tsx
//
// Animated SVG charts for the web Live Dashboard — plain React DOM, no React
// Native, no chart library. Built for a production TV:
//   • values tween (count up / bars grow / curves morph) whenever live data
//     changes, so an update is visible but never jumps;
//   • smooth monotone curves (never overshoot the data) with gradient areas;
//   • one y-axis per chart, a legend for multi-series charts, a value table
//     under the x-axis instead of a number on every point;
//   • hover crosshair + tooltip card for anyone at a desk;
//   • prefers-reduced-motion turns every animation off.

import React, { useEffect, useId, useRef, useState } from 'react';
import { BAND_COLORS, BAND_LABELS, efficiencyBand } from '../utils/lineEfficiency';

// ─── Formatting ───────────────────────────────────────────────────────────────
const intFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export const fmtInt = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? intFmt.format(Math.round(v)) : '—');
export const fmtPct = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : '—');
export function fmtMinutes(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const m = Math.max(0, Math.round(v));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// Props that make a card open its detail view: click, Enter or Space.
// Clicks on a control inside the card (a <button>) are left to that control.
export function openProps(onOpen: (() => void) | undefined, label: string) {
  if (!onOpen) return {};
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': `${label} — open detailed analysis`,
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      onOpen();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      onOpen();
    },
  };
}

// ─── Hooks ────────────────────────────────────────────────────────────────────
const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOutCubic = (k: number) => 1 - (1 - k) ** 3;

export function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

// Tweens an array of numbers to `target` (from 0 on first render), so charts
// grow in on load and morph smoothly on every live update.
export function useTween(target: number[], ms = 900): number[] {
  const [cur, setCur] = useState<number[]>(() => target.map(() => 0));
  const curRef = useRef(cur);
  const key = target.join('|');
  useEffect(() => {
    const from = curRef.current.length === target.length ? curRef.current : target.map(() => 0);
    if (reducedMotion()) {
      curRef.current = target;
      setCur(target);
      return undefined;
    }
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const e = easeOutCubic(Math.min(1, (t - start) / ms));
      const next = target.map((v, i) => from[i] + (v - from[i]) * e);
      curRef.current = next;
      setCur(next);
      if (e < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return cur;
}

// true for a moment after `value` changes (not on first render) — tiles glow
// briefly when live data updates them.
export function useFlash(value: unknown, ms = 1600): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    setOn(true);
    const id = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return on;
}

export function AnimatedNumber({ value, format }: { value: number | null | undefined; format: (v: number) => string }) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const [v] = useTween([known ? (value as number) : 0], 1100);
  return <>{known ? format(v) : '—'}</>;
}

// Counts up the one number inside a label ("1,234 pcs", "88.2%", "+120 pcs").
// Text with no number, or more than one ("1h 05m", "3 of 12"), is shown as is.
export function AnimatedText({ text }: { text: React.ReactNode }) {
  const m = typeof text === 'string' ? text.match(/\d[\d,]*(\.\d+)?/g) : null;
  const one = m && m.length === 1 ? m[0] : null;
  const target = one ? Number(one.replace(/,/g, '')) : 0;
  const [v] = useTween([target], 1100);
  if (!one || typeof text !== 'string') return <>{text}</>;
  const decimals = one.includes('.') ? one.split('.')[1].length : 0;
  const shown = new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
  return <>{text.replace(one, shown)}</>;
}

// ─── Donut: shares of a whole, arcs draw in and morph on updates ─────────────
// Slices are shades of one series colour (largest = full colour); the legend
// carries the labels and shares, so nothing relies on telling hues apart.
export function Donut({ items, tone, format, centerLabel, max = 6 }: {
  items: { key: string; label: string; value: number }[]; tone: 'good' | 'reject' | 'loss';
  format: (v: number) => string; centerLabel: string; max?: number;
}) {
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const shown = list.length > max ? [...list.slice(0, max - 1), { key: '__other', label: 'Other', value: list.slice(max - 1).reduce((n, i) => n + i.value, 0) }] : list;
  const total = shown.reduce((n, i) => n + i.value, 0);
  const v = useTween(shown.map((i) => i.value), 1200);
  const [hover, setHover] = useState<number | null>(null);
  if (!total) return <div className="ld-empty ld-empty--good ld-dempty">Nothing recorded.</div>;
  const R = 42;
  const C = 2 * Math.PI * R;
  const opacity = (i: number) => Math.max(0.22, 1 - i * 0.16);
  let acc = 0;
  const h = hover != null ? shown[hover] : null;
  return (
    <div className={`ld-donut ld-donut--${tone}`}>
      <svg viewBox="0 0 120 120" role="img" aria-label={`${centerLabel}: ${shown.map((i) => `${i.label} ${format(i.value)}`).join(', ')}`}>
        <circle className="ld-donut__track" cx="60" cy="60" r={R} />
        <g transform="rotate(-90 60 60)">
          {shown.map((it, i) => {
            const len = ((v[i] ?? 0) / total) * C; // v tweens from 0, so the ring draws in
            const seg = (
              <circle
                key={it.key}
                className={`ld-donut__seg${hover === i ? ' is-hover' : ''}`}
                cx="60" cy="60" r={R}
                style={{ strokeOpacity: opacity(i) }}
                strokeDasharray={`${Math.max(0, len - 1.2)} ${C}`}
                strokeDashoffset={-acc}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            );
            acc += len;
            return seg;
          })}
        </g>
        <text className="ld-donut__value" x="60" y="58" textAnchor="middle">{h ? format(h.value) : format(total)}</text>
        <text className="ld-donut__label" x="60" y="74" textAnchor="middle">{h ? `${Math.round((h.value / total) * 100)}% · ${h.label}`.slice(0, 22) : centerLabel}</text>
      </svg>
      <ul className="ld-donut__legend">
        {shown.map((it, i) => (
          <li key={it.key} className={hover === i ? 'is-hover' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ animationDelay: `${0.15 + i * 0.06}s` }}>
            <i style={{ opacity: opacity(i) }} />
            <span>{it.label}</span>
            <b>{format(it.value)}</b>
            <em>{Math.round((it.value / total) * 100)}%</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Heatmap: one row per line, one cell per day, cells pop in ───────────────
// Darker = higher value. Empty cells (null) mean no data that day.
export function Heatmap({ rows, days, tone, format, label }: {
  rows: { key: string; label: string; values: (number | null)[] }[]; days: DayPoint[];
  tone: 'good' | 'reject' | 'loss'; format: (v: number) => string; label: string;
}) {
  const all = rows.flatMap((r) => r.values.filter((x): x is number => x != null));
  const top = Math.max(1, ...all);
  if (!rows.length || !all.some((x) => x > 0)) return <div className="ld-empty ld-empty--good ld-dempty">Nothing recorded.</div>;
  return (
    <div className={`ld-heat ld-heat--${tone}`} role="table" aria-label={label} style={{ ['--cols' as any]: days.length }}>
      <div className="ld-heat__row ld-heat__row--head" role="row">
        <span role="columnheader" />
        {days.map((d) => <span key={d.key} role="columnheader" className={d.isToday ? 'is-today' : ''}>{d.isToday ? 'Today' : d.label}</span>)}
      </div>
      {rows.map((r, ri) => (
        <div key={r.key} className="ld-heat__row" role="row">
          <span role="rowheader" className="ld-heat__label" title={r.label}>{r.label}</span>
          {r.values.map((x, ci) => (
            <span
              key={ci}
              role="cell"
              className={`ld-heat__cell${x == null ? ' is-empty' : ''}${days[ci]?.isToday ? ' is-today' : ''}`}
              style={{ ['--k' as any]: x == null ? 0 : 0.12 + 0.88 * (x / top), animationDelay: `${ri * 0.05 + ci * 0.035}s` }}
              title={`${r.label} · ${days[ci]?.label}: ${x == null ? 'no data' : format(x)}`}
            >
              {x == null ? '' : format(x)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Geometry ─────────────────────────────────────────────────────────────────
export function niceMax(v: number): number {
  if (!(v > 0)) return 10;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => f <= s + 1e-9) ?? 10;
  return step * exp;
}

// Monotone cubic (Fritsch–Carlson) through the points: smooth, and never
// overshoots the data, so a curve never shows a peak that did not happen.
export function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (!n) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push(dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = dx[i] / 3;
    d += `C${x0 + h},${y0 + t[i] * h},${x1 - h},${y1 - t[i + 1] * h},${x1},${y1}`;
  }
  return d;
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '');

export interface DayPoint {
  key: string;
  label: string; // "Mon 27"
  isToday: boolean;
}

export interface ValueRow {
  label: string;
  values: string[];
}

interface Frame {
  width: number;
  height: number;
  m: { top: number; right: number; bottom: number; left: number };
  band: number;
  base: number;
  ih: number;
  cx: (i: number) => number;
  y: (v: number) => number;
  max: number;
}

function frame(width: number, height: number, n: number, max: number, rows: number): Frame {
  const m = { top: 30, right: 22, bottom: 36 + rows * 28, left: 76 };
  const iw = Math.max(0, width - m.left - m.right);
  const ih = Math.max(0, height - m.top - m.bottom);
  const band = n ? iw / n : 0;
  return {
    width, height, m, band, ih, max,
    base: m.top + ih,
    cx: (i) => m.left + band * i + band / 2,
    y: (v) => m.top + ih - (Math.max(0, v) / max) * ih,
  };
}

function Axes({ f, days, rows, unit, hover }: { f: Frame; days: DayPoint[]; rows: ValueRow[]; unit?: string; hover: number | null }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * f.max);
  // Narrow panels: weekday only ("Sat") and smaller value text, so labels never collide.
  const compact = f.band < 66;
  return (
    <g className={compact ? 'ld-compact' : undefined}>
      {ticks.map((t) => (
        <g key={t}>
          <line className="ld-gridline" x1={f.m.left} x2={f.width - f.m.right} y1={f.y(t)} y2={f.y(t)} />
          <text className="ld-tick" x={f.m.left - 12} y={f.y(t)} dy="0.32em" textAnchor="end">{fmtInt(t)}</text>
        </g>
      ))}
      {unit ? <text className="ld-unit" x={f.m.left - 12} y={f.m.top - 14} textAnchor="end">{unit}</text> : null}
      <line className="ld-baseline" x1={f.m.left} x2={f.width - f.m.right} y1={f.base} y2={f.base} />
      {days.map((d, i) => (
        <text key={d.key} className={`ld-xlabel${d.isToday ? ' is-today' : ''}${hover === i ? ' is-hover' : ''}`} x={f.cx(i)} y={f.base + 25} textAnchor="middle">
          {d.isToday ? 'Today' : compact ? d.label.split(' ')[0] : d.label}
        </text>
      ))}
      {rows.map((r, ri) => (
        <g key={r.label}>
          <text className="ld-rowlabel" x={f.m.left - 12} y={f.base + 53 + ri * 28} textAnchor="end">{r.label}</text>
          {r.values.map((v, i) => (
            <text key={i} className={`ld-rowvalue${days[i]?.isToday ? ' is-today' : ''}${hover === i ? ' is-hover' : ''}`} x={f.cx(i)} y={f.base + 53 + ri * 28} textAnchor="middle">{v}</text>
          ))}
        </g>
      ))}
    </g>
  );
}

// Hover band per day + crosshair, and an HTML tooltip card.
function HoverLayer({ f, n, hover, setHover }: { f: Frame; n: number; hover: number | null; setHover: (i: number | null) => void }) {
  return (
    <g onMouseLeave={() => setHover(null)}>
      {hover != null ? <line className="ld-crosshair" x1={f.cx(hover)} x2={f.cx(hover)} y1={f.m.top} y2={f.base} /> : null}
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} className="ld-hit" x={f.m.left + f.band * i} y={f.m.top} width={f.band} height={f.ih} onMouseEnter={() => setHover(i)} />
      ))}
    </g>
  );
}

function Tooltip({ f, i, title, lines }: { f: Frame; i: number; title: string; lines: { label: string; value: string; swatch?: string }[] }) {
  const left = f.cx(i);
  const flip = left > f.width * 0.66;
  return (
    <div className="ld-tip" style={{ left, top: f.m.top + 8, transform: `translateX(${flip ? 'calc(-100% - 14px)' : '14px'})` }}>
      <div className="ld-tip__title">{title}</div>
      {lines.map((l) => (
        <div key={l.label} className="ld-tip__row">
          {l.swatch ? <i style={{ background: l.swatch }} /> : null}
          <span>{l.label}</span>
          <b>{l.value}</b>
        </div>
      ))}
    </div>
  );
}

// ─── Production trend: smooth area (good) + dashed plan, one axis ────────────
export function TrendChart({ days, good, plan, achievement, rows, title }: {
  days: DayPoint[]; good: number[]; plan: number[]; achievement: (number | null)[]; rows: ValueRow[]; title: string;
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const id = safeId(useId());
  const g = useTween(good, 1100);
  const p = useTween(plan, 1100);
  const [reveal] = useTween([1], 1600);
  const max = niceMax(Math.max(1, ...good, ...plan) * 1.1);
  const f = frame(width, height, days.length, max, rows.length);
  const goodPts = g.map((v, i) => [f.cx(i), f.y(v)] as [number, number]);
  const planPts = p.map((v, i) => [f.cx(i), f.y(v)] as [number, number]);
  const line = smoothPath(goodPts);
  const area = goodPts.length ? `${line}L${goodPts[goodPts.length - 1][0]},${f.base}L${goodPts[0][0]},${f.base}Z` : '';
  const ti = days.findIndex((d) => d.isToday);
  const peak = good.indexOf(Math.max(...good));

  return (
    <div className="ld-chart" ref={ref}>
      {width > 0 && height > 0 ? (
        <>
          <svg width={width} height={height} role="img" aria-label={title}>
            <defs>
              <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--good)" stopOpacity="0.38" />
                <stop offset="100%" stopColor="var(--good)" stopOpacity="0" />
              </linearGradient>
              <filter id={`${id}-glow`} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <clipPath id={`${id}-reveal`}>
                <rect x={0} y={0} width={f.m.left + (width - f.m.left) * reveal} height={height} />
              </clipPath>
            </defs>
            <Axes f={f} days={days} rows={rows} unit="pcs" hover={hover} />
            <g clipPath={`url(#${id}-reveal)`}>
              <path d={area} fill={`url(#${id}-area)`} />
              <path className="ld-line ld-line--plan" d={smoothPath(planPts)} />
              <path className="ld-line ld-line--good" d={line} filter={`url(#${id}-glow)`} />
              {goodPts.map(([x, y], i) => (i === ti ? null : <circle key={i} className="ld-dot" cx={x} cy={y} r={hover === i ? 8 : 6} />))}
            </g>
            {ti >= 0 && goodPts[ti] ? (
              <g transform={`translate(${goodPts[ti][0]},${goodPts[ti][1]})`}>
                <circle className="ld-pulse" r={9} />
                <circle className="ld-dot ld-dot--today" r={8} />
              </g>
            ) : null}
            {[...new Set([peak, ti])].filter((i) => i >= 0 && good[i] > 0 && goodPts[i]).map((i) => (
              <text key={i} className="ld-direct" x={goodPts[i][0]} y={goodPts[i][1] - 18} textAnchor="middle">{fmtInt(g[i])}</text>
            ))}
            <HoverLayer f={f} n={days.length} hover={hover} setHover={setHover} />
          </svg>
          {hover != null ? (
            <Tooltip
              f={f}
              i={hover}
              title={days[hover].isToday ? 'Today (in progress)' : days[hover].label}
              lines={[
                { label: 'Good production', value: `${fmtInt(good[hover])} pcs`, swatch: 'var(--good)' },
                { label: 'Plan', value: `${fmtInt(plan[hover])} pcs`, swatch: 'var(--plan)' },
                { label: 'Achievement', value: fmtPct(achievement[hover]) },
              ]}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ─── Line trend: one measure per day, smooth line + area, dashed average ─────
export function LineTrendChart({ days, values, rows, title, tone, unit, format, extra }: {
  days: DayPoint[]; values: number[]; rows: ValueRow[]; title: string; tone: 'reject' | 'loss'; unit: string;
  format: (v: number) => string; extra?: (i: number) => { label: string; value: string }[];
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const id = safeId(useId());
  const v = useTween(values, 1100);
  const [reveal] = useTween([1], 1600);
  const max = niceMax(Math.max(1, ...values) * 1.15);
  const f = frame(width, height, days.length, max, rows.length);
  const pts = v.map((val, i) => [f.cx(i), f.y(val)] as [number, number]);
  const line = smoothPath(pts);
  const area = pts.length ? `${line}L${pts[pts.length - 1][0]},${f.base}L${pts[0][0]},${f.base}Z` : '';
  const ti = days.findIndex((d) => d.isToday);
  const peak = values.indexOf(Math.max(...values));
  // Average of the completed days (today is still running).
  const done = values.filter((_, i) => i !== ti);
  const avg = done.length ? done.reduce((n, x) => n + x, 0) / done.length : 0;
  const color = tone === 'reject' ? 'var(--reject)' : 'var(--loss)';
  const change = (i: number) => {
    if (i === 0) return '—';
    const d = values[i] - values[i - 1];
    return d === 0 ? 'No change' : `${d > 0 ? '▲ +' : '▼ −'}${format(Math.abs(d))}`;
  };

  return (
    <div className="ld-chart" ref={ref}>
      {width > 0 && height > 0 ? (
        <>
          <svg width={width} height={height} role="img" aria-label={title}>
            <defs>
              <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.36" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
              <filter id={`${id}-glow`} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <clipPath id={`${id}-reveal`}>
                <rect x={0} y={0} width={f.m.left + (width - f.m.left) * reveal} height={height} />
              </clipPath>
            </defs>
            <Axes f={f} days={days} rows={rows} unit={unit} hover={hover} />
            {avg > 0 ? (
              <g>
                <line className="ld-avg" x1={f.m.left} x2={f.width - f.m.right} y1={f.y(avg)} y2={f.y(avg)} />
                <text className="ld-avg__label" x={f.width - f.m.right} y={f.y(avg) - 7} textAnchor="end">avg {format(avg)}</text>
              </g>
            ) : null}
            <g clipPath={`url(#${id}-reveal)`}>
              <path d={area} fill={`url(#${id}-area)`} />
              <path className="ld-line" d={line} stroke={color} strokeWidth={3} filter={`url(#${id}-glow)`} />
              {pts.map(([x, y], i) => (i === ti ? null : <circle key={i} className="ld-dot" style={{ fill: color }} cx={x} cy={y} r={hover === i ? 8 : 6} />))}
            </g>
            {ti >= 0 && pts[ti] ? (
              <g transform={`translate(${pts[ti][0]},${pts[ti][1]})`}>
                <circle className="ld-pulse" style={{ fill: color }} r={9} />
                <circle className="ld-dot ld-dot--today" style={{ stroke: color }} r={8} />
              </g>
            ) : null}
            {[...new Set([peak, ti])].filter((i) => i >= 0 && values[i] > 0 && pts[i]).map((i) => (
              <text key={i} className="ld-direct" x={pts[i][0]} y={pts[i][1] - 18} textAnchor="middle">{format(v[i])}</text>
            ))}
            <HoverLayer f={f} n={days.length} hover={hover} setHover={setHover} />
          </svg>
          {hover != null ? (
            <Tooltip
              f={f}
              i={hover}
              title={days[hover].isToday ? 'Today (in progress)' : days[hover].label}
              lines={[
                { label: title, value: format(values[hover]), swatch: color },
                { label: 'vs previous day', value: change(hover) },
                { label: 'Average (completed days)', value: format(avg) },
                ...(extra ? extra(hover) : []),
              ]}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ─── Column chart: one measure per day, gradient bars that grow ──────────────
export function BarChart({ days, values, rows, title, tone, unit, format, extra }: {
  days: DayPoint[]; values: number[]; rows: ValueRow[]; title: string; tone: 'reject' | 'loss'; unit: string;
  format: (v: number) => string; extra?: (i: number) => { label: string; value: string }[];
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const id = safeId(useId());
  const v = useTween(values, 1000);
  const max = niceMax(Math.max(1, ...values) * 1.15);
  const f = frame(width, height, days.length, max, rows.length);
  const bw = Math.min(f.band * 0.56, 60);
  const ti = days.findIndex((d) => d.isToday);
  const color = tone === 'reject' ? 'var(--reject)' : 'var(--loss)';

  return (
    <div className="ld-chart" ref={ref}>
      {width > 0 && height > 0 ? (
        <>
          <svg width={width} height={height} role="img" aria-label={title}>
            <defs>
              <linearGradient id={`${id}-bar`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="1" />
                <stop offset="100%" stopColor={color} stopOpacity="0.55" />
              </linearGradient>
              <pattern id={`${id}-live`} width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="10" height="10" fill={color} fillOpacity="0.55" />
                <rect width="4" height="10" fill={color} />
              </pattern>
            </defs>
            <Axes f={f} days={days} rows={rows} unit={unit} hover={hover} />
            {v.map((val, i) => {
              const x = f.cx(i) - bw / 2;
              const top = f.y(val);
              const h = f.base - top;
              const r = Math.min(5, bw / 2, h);
              if (h <= 0.5) return null;
              const d = `M${x},${f.base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${f.base}Z`;
              const today = i === ti;
              return (
                <path
                  key={days[i].key}
                  className={`ld-bar${today ? ' ld-bar--today' : ''}${hover === i ? ' is-hover' : ''}`}
                  d={d}
                  fill={today ? `url(#${id}-live)` : `url(#${id}-bar)`}
                />
              );
            })}
            {ti >= 0 && values[ti] > 0 ? (
              <text className="ld-direct" x={f.cx(ti)} y={f.y(v[ti]) - 12} textAnchor="middle">{format(v[ti])}</text>
            ) : null}
            <HoverLayer f={f} n={days.length} hover={hover} setHover={setHover} />
          </svg>
          {hover != null ? (
            <Tooltip
              f={f}
              i={hover}
              title={days[hover].isToday ? 'Today (in progress)' : days[hover].label}
              lines={[{ label: title, value: format(values[hover]), swatch: color }, ...(extra ? extra(hover) : [])]}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ─── Sparkline (KPI tiles) ────────────────────────────────────────────────────
export function Sparkline({ values, tone }: { values: number[]; tone: 'good' | 'reject' | 'loss' }) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const id = safeId(useId());
  const v = useTween(values, 1200);
  const max = Math.max(1, ...values) * 1.1;
  const pad = 4;
  const pts = v.map((val, i) => [
    pad + (v.length > 1 ? (i / (v.length - 1)) * (width - pad * 2) : 0),
    height - pad - (Math.max(0, val) / max) * (height - pad * 2),
  ] as [number, number]);
  const line = smoothPath(pts);
  const last = pts[pts.length - 1];
  return (
    <div className="ld-spark" ref={ref} aria-hidden="true">
      {width > 0 && height > 0 && pts.length ? (
        <svg width={width} height={height}>
          <defs>
            <linearGradient id={`${id}-sp`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`var(--${tone})`} stopOpacity="0.35" />
              <stop offset="100%" stopColor={`var(--${tone})`} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line}L${last[0]},${height}L${pts[0][0]},${height}Z`} fill={`url(#${id}-sp)`} />
          <path d={line} fill="none" stroke={`var(--${tone})`} strokeWidth={2} strokeLinecap="round" />
          <circle cx={last[0]} cy={last[1]} r={3.5} fill={`var(--${tone})`} />
        </svg>
      ) : null}
    </div>
  );
}

// ─── Achievement gauge (the app's efficiency bands, always with a label) ─────
export function Gauge({ pct }: { pct: number | null }) {
  const known = typeof pct === 'number' && Number.isFinite(pct);
  const [v] = useTween([known ? (pct as number) : 0], 1300);
  const band = known ? efficiencyBand(pct as number) : null;
  const color = band ? BAND_COLORS[band] : 'var(--muted)';
  const R = 80;
  const C = Math.PI * R; // half circle
  const shown = Math.max(0, Math.min(100, v)) / 100;
  return (
    <div className="ld-gauge">
      <svg viewBox="0 0 200 116" role="img" aria-label={`Achievement ${fmtPct(pct)}${band ? `, ${BAND_LABELS[band]}` : ''}`}>
        <path d="M20,100 A80,80 0 0 1 180,100" className="ld-gauge__track" />
        <path
          d="M20,100 A80,80 0 0 1 180,100"
          className="ld-gauge__value"
          style={{ stroke: color, strokeDasharray: `${C}`, strokeDashoffset: `${C * (1 - shown)}`, filter: `drop-shadow(0 0 6px ${color})` }}
        />
        {[50, 75, 90].map((t) => {
          const a = Math.PI * (1 - t / 100);
          return <line key={t} className="ld-gauge__tick" x1={100 + 68 * Math.cos(a)} y1={100 - 68 * Math.sin(a)} x2={100 + 92 * Math.cos(a)} y2={100 - 92 * Math.sin(a)} />;
        })}
        <text x="100" y="92" textAnchor="middle" className="ld-gauge__num">{known ? `${v.toFixed(1)}%` : '—'}</text>
      </svg>
      {band ? <span className="ld-band" style={{ color, borderColor: color }}>{BAND_LABELS[band]}</span> : null}
    </div>
  );
}

// ─── Ranked horizontal bars (downtime by reason) ──────────────────────────────
export function ReasonBars({ items, total, max = 6 }: { items: { reason: string; label: string; minutes: number }[]; total: number; max?: number }) {
  const list = items.filter((r) => r.minutes > 0);
  const shown = list.slice(0, max);
  const top = Math.max(1, ...shown.map((r) => r.minutes));
  const widths = useTween(shown.map((r) => (r.minutes / top) * 100), 1100);
  if (!shown.length) return <div className="ld-empty ld-empty--good">No downtime recorded this week.</div>;
  return (
    <ol className="ld-reasons">
      {shown.map((r, i) => (
        <li key={r.reason} title={`${r.label}: ${fmtMinutes(r.minutes)}`}>
          <span className="ld-reasons__rank">{i + 1}</span>
          <span className="ld-reasons__label">{r.label}</span>
          <span className="ld-reasons__track"><span className="ld-reasons__fill" style={{ width: `${widths[i] ?? 0}%` }} /></span>
          <span className="ld-reasons__value">{fmtMinutes(r.minutes)}</span>
          <span className="ld-reasons__share">{total > 0 ? `${Math.round((r.minutes / total) * 100)}%` : ''}</span>
        </li>
      ))}
      {list.length > max ? <li className="ld-reasons__more">+{list.length - max} more reason{list.length - max === 1 ? '' : 's'}</li> : null}
    </ol>
  );
}

// ─── Plan vs actual (grouped bars, one axis, Monday → Sunday) ────────────────
export function PlanActualChart({ days, plan, actual, achievement, future, title }: {
  days: DayPoint[]; plan: (number | null)[]; actual: (number | null)[]; achievement: (number | null)[]; future: boolean[]; title: string;
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const id = safeId(useId());
  const p = useTween(plan.map((v) => v ?? 0), 1000);
  const a = useTween(actual.map((v) => v ?? 0), 1000);
  const max = niceMax(Math.max(1, ...plan.map((v) => v ?? 0), ...actual.map((v) => v ?? 0)) * 1.12);
  const rows: ValueRow[] = [{ label: 'Ach.', values: achievement.map((v, i) => (future[i] ? '' : fmtPct(v))) }];
  const f = frame(width, height, days.length, max, rows.length);
  const bw = Math.min((f.band * 0.72) / 2, 26);
  const bar = (x: number, v: number) => {
    const top = f.y(v);
    const h = f.base - top;
    if (h <= 0.5) return '';
    const r = Math.min(4, bw / 2, h);
    return `M${x},${f.base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${f.base}Z`;
  };
  return (
    <div className="ld-chart" ref={ref}>
      {width > 0 && height > 0 ? (
        <>
          <svg width={width} height={height} role="img" aria-label={title}>
            <defs>
              <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--good)" />
                <stop offset="100%" stopColor="var(--good)" stopOpacity="0.55" />
              </linearGradient>
            </defs>
            <Axes f={f} days={days} rows={rows} unit="pcs" hover={hover} />
            {days.map((d, i) => {
              const cx = f.cx(i);
              if (future[i]) return <text key={d.key} className="ld-future" x={cx} y={f.base - 10} textAnchor="middle">—</text>;
              return (
                <g key={d.key} className={hover === i ? 'is-hover' : ''}>
                  <path className="ld-bar ld-bar--plan" d={bar(cx - bw - 1.5, p[i])} />
                  <path className={`ld-bar${d.isToday ? ' ld-bar--today' : ''}`} d={bar(cx + 1.5, a[i])} fill={`url(#${id}-a)`} />
                </g>
              );
            })}
            <HoverLayer f={f} n={days.length} hover={hover} setHover={setHover} />
          </svg>
          {hover != null && !future[hover] ? (
            <Tooltip
              f={f}
              i={hover}
              title={days[hover].isToday ? 'Today (in progress)' : days[hover].label}
              lines={[
                { label: 'Plan', value: `${fmtInt(plan[hover])} pcs`, swatch: 'var(--plan)' },
                { label: 'Actual (good)', value: `${fmtInt(actual[hover])} pcs`, swatch: 'var(--good)' },
                { label: 'Achievement', value: fmtPct(achievement[hover]) },
              ]}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ─── Types of rejection (ranked bars, "Other" folds the tail) ────────────────
export function RejectionTypeBars({ rows, total, max = 7 }: { rows: { defect: string; stage: string | null; qty: number }[]; total: number; max?: number }) {
  const list = rows.filter((r) => r.qty > 0);
  const head = list.slice(0, list.length > max ? max - 1 : max);
  const tail = list.slice(head.length);
  const shown = tail.length
    ? [...head, { defect: `Other (${tail.length} types)`, stage: null, qty: tail.reduce((s, r) => s + r.qty, 0) }]
    : head;
  const top = Math.max(1, ...shown.map((r) => r.qty));
  const widths = useTween(shown.map((r) => (r.qty / top) * 100), 1100);
  if (!shown.length) return <div className="ld-empty ld-empty--good">No rejections recorded this week.</div>;
  return (
    <ol className="ld-types">
      {shown.map((r, i) => (
        <li key={r.defect} title={`${r.defect}: ${fmtInt(r.qty)} pcs`}>
          <span className="ld-types__label">
            {r.defect}
            {r.stage ? <em>{r.stage}</em> : null}
          </span>
          <span className="ld-types__track"><span className="ld-types__fill" style={{ width: `${widths[i] ?? 0}%` }} /></span>
          <span className="ld-types__value">{fmtInt(r.qty)}</span>
          <span className="ld-types__share">{total > 0 ? `${Math.round((r.qty / total) * 100)}%` : ''}</span>
        </li>
      ))}
    </ol>
  );
}

// ─── Lines stopped right now (live timers) ────────────────────────────────────
export function StoppedLinesBoard({ lines, activeCount }: {
  lines: { lineId: string; lineName: string; plant: string | null; shift: string | null; reason: string | null; sinceMs: number | null }[];
  activeCount: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!lines.length) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lines.length]);
  const elapsed = (ms: number | null) => {
    if (ms == null) return '—';
    const s = Math.max(0, Math.floor((now - ms) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  if (!lines.length) {
    return (
      <div className="ld-allrun">
        <div className="ld-allrun__icon" aria-hidden="true">✓</div>
        <div className="ld-allrun__title">All lines running</div>
        <div className="ld-allrun__sub">{activeCount ? `${activeCount} line${activeCount === 1 ? '' : 's'} in production, none stopped` : 'No line in production right now'}</div>
      </div>
    );
  }
  return (
    <ul className="ld-stopped">
      {lines.map((l) => (
        <li key={l.lineId}>
          <span className="ld-stopped__dot" aria-hidden="true" />
          <span className="ld-stopped__main">
            <b>{l.lineName}</b>
            <span>{[l.reason ?? 'Reason not recorded', l.plant, l.shift ? `Shift ${l.shift}` : null].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="ld-stopped__timer" title="Stopped for">{elapsed(l.sinceMs)}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Rotating panel: cycles its views, pauses on hover ───────────────────────
export function RotatingPanel({ views, intervalMs = 15000, onOpen }: { views: { title: string; meta?: React.ReactNode; body: React.ReactNode }[]; intervalMs?: number; onOpen?: () => void }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || views.length < 2) return undefined;
    const t = setInterval(() => setI((n) => (n + 1) % views.length), intervalMs);
    return () => clearInterval(t);
  }, [paused, views.length, intervalMs]);
  const v = views[i % views.length];
  return (
    <section className={`ld-panel${onOpen ? ' is-clickable' : ''}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} {...openProps(onOpen, v.title)}>
      <header className="ld-panel__head">
        <h2 className="ld-panel__title">{v.title}</h2>
        <span className="ld-dots">
          {views.map((view, k) => (
            <button key={view.title} className={k === i % views.length ? 'is-on' : ''} onClick={() => setI(k)} aria-label={`Show ${view.title}`} />
          ))}
        </span>
      </header>
      {v.meta ? <div className="ld-panel__sub">{v.meta}</div> : null}
      <div key={i} className="ld-rotate">{v.body}</div>
      {!paused && views.length > 1 ? <div key={`p${i}`} className="ld-progress" style={{ animationDuration: `${intervalMs}ms` }} /> : null}
    </section>
  );
}
