// src/liveDashboard/RunningLinesPage.tsx
//
// Second page of the web Live Dashboard (swipe left from the overview):
// every line with a live session and its production details. Cards come
// from supervisorHandover.buildRunningLineCards — the Running Lines screen's
// own figures — via utils/liveDashboard.liveLines. Plain React DOM + SVG.
//
// Each hour of the shift is a dot: green and filled once that hour's
// production is saved, empty until then. The current hour pulses; an hour
// that has ended without an entry keeps an amber ring so it isn't missed.

import React, { useEffect, useState } from 'react';
import type { LiveLine, LiveSlot } from '../utils/liveDashboard';
import { RUNNING_STATUS_COLORS, RUNNING_STATUS_LABELS, RunningStatus } from '../utils/supervisorHandover';
import { BAND_COLORS, efficiencyBand } from '../utils/lineEfficiency';
import { AnimatedNumber, fmtInt, fmtMinutes, fmtPct, openProps, useFlash, useTween } from './charts';

function useSecondTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function elapsed(fromMs: number | null, now: number) {
  if (fromMs == null) return '—';
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Grid that fits n cards on the page without scrolling.
function grid(n: number) {
  if (n <= 2) return { cols: Math.max(1, n), rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  if (n <= 12) return { cols: 4, rows: 3 };
  if (n <= 16) return { cols: 4, rows: 4 };
  return { cols: 5, rows: Math.ceil(n / 5) };
}

const SLOT_TEXT: Record<LiveSlot['state'], string> = {
  completed: 'saved',
  current: 'running now',
  awaiting: 'ended — entry pending',
  upcoming: 'not started',
};

// ─── Hourly dots ──────────────────────────────────────────────────────────────
function HourDots({ slots }: { slots: LiveSlot[] }) {
  if (!slots.length) return <div className="ll-hours ll-hours--empty">No hourly slots</div>;
  // The track fills up to the last saved hour.
  const lastDone = slots.reduce((m, s, i) => (s.state === 'completed' ? i : m), -1);
  const fill = slots.length > 1 ? Math.max(0, lastDone) / (slots.length - 1) : lastDone >= 0 ? 1 : 0;
  const [w] = useTween([fill * 100], 900);
  return (
    <div className="ll-hours" style={{ ['--n' as any]: slots.length }}>
      <div className="ll-hours__track" aria-hidden="true">
        <div className="ll-hours__fill" style={{ width: `${w}%` }} />
      </div>
      <ol className="ll-hours__dots">
        {slots.map((s, i) => {
          const tip = `${s.range} · ${SLOT_TEXT[s.state]}${s.produced != null ? ` · ${fmtInt(s.produced)} / ${fmtInt(s.expected)} pcs` : ''}`;
          return (
            <li key={s.index} title={tip} aria-label={tip}>
              {/* keyed by state, so a dot pops when it turns green */}
              <span key={s.state} className={`ll-dot ll-dot--${s.state}`} style={{ animationDelay: `${i * 0.05}s` }}>
                {s.state === 'completed' ? (
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.6 2.6L12 5.6" /></svg>
                ) : s.state === 'awaiting' ? (
                  <b aria-hidden="true">!</b>
                ) : null}
              </span>
              <span className={`ll-dot__label${s.state === 'current' ? ' is-now' : ''}`}>{s.range}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ─── Achievement ring (the app's efficiency bands) ───────────────────────────
function Ring({ pct }: { pct: number | null }) {
  const known = typeof pct === 'number' && Number.isFinite(pct);
  const [v] = useTween([known ? (pct as number) : 0], 1200);
  const color = known ? BAND_COLORS[efficiencyBand(pct as number)] : 'var(--muted)';
  const R = 26;
  const C = 2 * Math.PI * R;
  const shown = Math.max(0, Math.min(100, v)) / 100;
  return (
    <div className="ll-ring" title="Achievement (good ÷ plan to date)">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={R} className="ll-ring__track" />
        <circle
          cx="32" cy="32" r={R} className="ll-ring__value"
          style={{ stroke: color, strokeDasharray: `${C}`, strokeDashoffset: `${C * (1 - shown)}`, filter: `drop-shadow(0 0 4px ${color})` }}
        />
      </svg>
      <span className="ll-ring__num">{known ? `${v.toFixed(v >= 100 ? 0 : 1)}%` : '—'}</span>
    </div>
  );
}

function LineTile({ line, now, dense, order, onOpen }: { line: LiveLine; now: number; dense: boolean; order: number; onOpen?: () => void }) {
  const c = line.card;
  // The card itself is only red (stopped) or the running look; "awaiting
  // entry" is marked by its badge, the hour dots and one line of text.
  const tone: RunningStatus = c.status === 'stopped' ? 'stopped' : 'running';
  const color = RUNNING_STATUS_COLORS[tone];
  const flash = useFlash(c.actual);
  const shiftPct = c.shiftPlan && c.shiftPlan > 0 ? Math.min(100, (c.actual / c.shiftPlan) * 100) : null;
  const [shiftW] = useTween([shiftPct ?? 0], 1000);
  const pending = c.slots.awaiting.length;
  const total = line.slots.length;
  const saved = c.slots.completed.length;
  const meta = [c.model, c.section, `Shift ${c.shift}`, line.plant].filter(Boolean).join(' · ');

  return (
    <article
      className={`ll-card ll-card--${tone}${dense ? ' ll-card--dense' : ''}${flash ? ' is-updated' : ''}${onOpen ? ' is-clickable' : ''}`}
      {...openProps(onOpen, c.lineName)}
      style={{ ['--st' as any]: color, animationDelay: `${order * 0.06}s` }}
    >
      <div className="ll-card__accent" aria-hidden="true" />
      <header className="ll-card__head">
        <h3 className="ll-card__name" title={c.lineName}>{c.lineName}</h3>
        <span className="ll-status" style={{ ['--st' as any]: RUNNING_STATUS_COLORS[c.status] }}><i aria-hidden="true" />{RUNNING_STATUS_LABELS[c.status]}</span>
      </header>
      <div className="ll-card__meta" title={meta}>{meta || '—'}</div>

      <div className="ll-card__body">
        <Ring pct={line.achievementPct} />
        <div className="ll-card__figures">
          <div className="ll-card__actual">
            <span className="ll-big"><AnimatedNumber value={c.actual} format={fmtInt} /></span>
            <span className="ll-of">/ {fmtInt(c.planToDate)} plan</span>
            <span className={`ll-var ${c.variance >= 0 ? 'll-up' : 'll-down'}`}>
              {c.variance >= 0 ? '▲ +' : '▼ −'}{fmtInt(Math.abs(c.variance))}
            </span>
          </div>
          {c.shiftPlan ? (
            <div className="ll-shift" title={`${fmtInt(c.actual)} of ${fmtInt(c.shiftPlan)} planned for the shift`}>
              <div className="ll-shift__track"><div className="ll-shift__fill" style={{ width: `${shiftW}%` }} /></div>
              <span>{fmtInt(c.shiftPlan)} shift</span>
            </div>
          ) : null}
        </div>
      </div>

      <HourDots slots={line.slots} />

      <dl className="ll-card__stats">
        <div><dt>Hours saved</dt><dd>{saved}/{total}</dd></div>
        <div><dt>Rej</dt><dd>{fmtInt(c.rejections)}</dd></div>
        <div><dt>Downtime</dt><dd>{fmtMinutes(line.downtimeMinutes)}</dd></div>
      </dl>

      {c.status === 'stopped' ? (
        <div className="ll-strip ll-strip--stopped">
          <span>{line.stop?.reason ?? 'Stopped — reason not recorded'}</span>
          <b>{elapsed(line.stop?.sinceMs ?? null, now)}</b>
        </div>
      ) : pending ? (
        <div className="ll-note-awaiting">
          <i aria-hidden="true" />
          <span>Awaiting entry: {line.slots.filter((s) => s.state === 'awaiting').map((s) => s.range).slice(0, 3).join(', ')}{pending > 3 ? ` +${pending - 3}` : ''}</span>
        </div>
      ) : null}
    </article>
  );
}

function Chip({ status, count }: { status: RunningStatus; count: number }) {
  const flash = useFlash(count);
  return (
    <span className={`ll-chip${flash ? ' is-updated' : ''}`} style={{ ['--st' as any]: RUNNING_STATUS_COLORS[status] }}>
      <i aria-hidden="true" /><b><AnimatedNumber value={count} format={fmtInt} /></b> {RUNNING_STATUS_LABELS[status]}
    </span>
  );
}

export default function RunningLinesPage({ lines, active, onOpenLine }: { lines: LiveLine[] | null; active: boolean; onOpenLine?: (lineId: string) => void }) {
  const anyStopped = !!lines?.some((l) => l.card.status === 'stopped');
  const now = useSecondTick(anyStopped && active);

  if (!lines) {
    return <div className="ld-empty"><div className="ld-spinner" aria-hidden="true" /></div>;
  }
  const counts: Record<RunningStatus, number> = { running: 0, awaiting_entry: 0, stopped: 0 };
  lines.forEach((l) => { counts[l.card.status] += 1; });
  const { cols, rows } = grid(lines.length);

  return (
    <div className="ll">
      <div className="ll-summary">
        <h2 className="ll-summary__title">Running lines <span>{lines.length} live</span></h2>
        <div className="ll-summary__chips">
          {(['running', 'awaiting_entry', 'stopped'] as RunningStatus[]).map((s) => <Chip key={s} status={s} count={counts[s]} />)}
        </div>
        <div className="ll-legend" aria-hidden="true">
          <span><i className="ll-dot ll-dot--completed ll-dot--mini" />Hour saved</span>
          <span><i className="ll-dot ll-dot--current ll-dot--mini" />Current hour</span>
          <span><i className="ll-dot ll-dot--awaiting ll-dot--mini" />Not entered</span>
          <span><i className="ll-dot ll-dot--upcoming ll-dot--mini" />Upcoming</span>
        </div>
      </div>
      {lines.length ? (
        // Re-keyed on activation so the cards animate in each time the page is shown.
        <div key={active ? 'shown' : 'hidden'} className="ll-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
          {lines.map((l, i) => <LineTile key={l.card.lineId} line={l} now={now} dense={rows > 2} order={i} onOpen={onOpenLine ? () => onOpenLine(l.card.lineId) : undefined} />)}
        </div>
      ) : (
        <div className="ld-empty">No line is in production right now. Lines appear here as soon as a supervisor starts a session.</div>
      )}
    </div>
  );
}
