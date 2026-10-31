// src/liveDashboard/DetailView.tsx
//
// In-depth analysis of one Live Dashboard card, opened by clicking it (KPI
// tile, panel or Running lines card). Full-screen over the dashboard, live
// like the rest of it: every figure is recomputed from the same snapshots.
// Breakdowns come from utils/liveDashboard (daySeries / productionBreakdown /
// groupQty), so a line or shift row uses the exact formulas of the card.
// Esc or Back closes it.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LiveWeekData } from './useLiveWeekData';
import {
  BreakdownRow, DashboardRecord, DaySummary, RejectionEntry,
  daySeries, dashboardDays, groupQty, productionBreakdown, reasonLabel, rejectionsPerDay,
} from '../utils/liveDashboard';
import type { DowntimeInterval } from '../utils/downtime';
import { downtimeByReason } from '../utils/downtime';
import { AnimatedText, BarChart, DayPoint, Donut, Heatmap, LineTrendChart, PlanActualChart, useTween, ReasonBars, TrendChart, fmtInt, fmtMinutes, fmtPct } from './charts';

export type DetailKind =
  | 'good' | 'achievement' | 'rejToday' | 'lossToday' | 'downtimeToday' | 'week'
  | 'trend' | 'planActual' | 'stopped' | 'rejPerDay' | 'rejTypes' | 'lossPerDay' | 'downtime';
export type DetailKey = { kind: DetailKind } | { kind: 'line'; lineId: string };

type Tone = 'good' | 'reject' | 'loss';

// Record Rejection qty as a share of that day's parts (good + rejected).
const rejRate = (rejected: number, good: number) =>
  good + rejected > 0 ? Math.round((rejected / (good + rejected)) * 1000) / 10 : null;
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
const shiftName = (k: string) => (k === '—' ? 'Unknown' : `Shift ${k}`);

// ─── Building blocks ──────────────────────────────────────────────────────────

function Stat({ label, value, sub, tone = 'good' }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  return (
    <div className={`ld-dstat ld-kpi--${tone}`}>
      <span className="ld-dstat__label">{label}</span>
      <b className="ld-dstat__value">{typeof value === 'string' && /^[+−-]?\d/.test(value) ? <AnimatedText text={value} /> : value}</b>
      {sub ? <span className="ld-dstat__sub">{sub}</span> : null}
    </div>
  );
}

function DPanel({ title, meta, wide, chart, children }: { title: string; meta?: React.ReactNode; wide?: boolean; chart?: boolean; children: React.ReactNode }) {
  return (
    <section className={`ld-panel ld-dpanel${wide ? ' ld-dpanel--wide' : ''}${chart ? ' ld-dpanel--chart' : ''}`}>
      <header className="ld-panel__head">
        <h2 className="ld-panel__title">{title}</h2>
        {meta ? <span className="ld-panel__meta">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

interface BarRow { key: string; label: string; sub?: string; value: number; display: string }

// Ranked horizontal bars, every row (the detail view scrolls).
function HBars({ rows, tone, empty, total }: { rows: BarRow[]; tone: Tone; empty: string; total?: number }) {
  const shown = rows.filter((r) => r.value > 0);
  if (!shown.length) return <div className="ld-empty ld-empty--good ld-dempty">{empty}</div>;
  const top = Math.max(1, ...shown.map((r) => r.value));
  const widths = useTween(shown.map((r) => (r.value / top) * 100), 1100);
  return (
    <ol className={`ld-hbars ld-hbars--${tone}`}>
      {shown.map((r, i) => (
        <li key={r.key} title={`${r.label}: ${r.display}`} style={{ animationDelay: `${Math.min(i, 12) * 0.05}s` }}>
          <span className="ld-hbars__rank">{i + 1}</span>
          <span className="ld-hbars__label">{r.label}{r.sub ? <em>{r.sub}</em> : null}</span>
          <span className="ld-hbars__track"><span className="ld-hbars__fill" style={{ width: `${widths[i] ?? 0}%` }} /></span>
          <span className="ld-hbars__value">{r.display}</span>
          {total ? <span className="ld-hbars__share">{Math.round((r.value / total) * 100)}%</span> : null}
        </li>
      ))}
    </ol>
  );
}

interface TRow { key: string; cells: React.ReactNode[]; today?: boolean; alert?: boolean }

function Table({ head, rows, foot, empty = 'Nothing recorded.' }: { head: string[]; rows: TRow[]; foot?: React.ReactNode[]; empty?: string }) {
  if (!rows.length) return <div className="ld-empty ld-dempty">{empty}</div>;
  return (
    <div className="ld-table">
      <table>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={`${r.today ? 'is-today' : ''}${r.alert ? ' is-alert' : ''}`} style={{ animationDelay: `${Math.min(i, 15) * 0.035}s` }}>
              {r.cells.map((c, i) => <td key={i}>{c}</td>)}
            </tr>
          ))}
        </tbody>
        {foot ? <tfoot><tr>{foot.map((c, i) => <td key={i}>{c}</td>)}</tr></tfoot> : null}
      </table>
    </div>
  );
}

const achClass = (pct: number | null) => (pct == null ? '' : pct >= 95 ? 'ld-ok' : pct < 80 ? 'ld-crit' : '');

// Line / shift breakdown with the card formulas.
function ProductionTable({ rows, label, first }: { rows: BreakdownRow[]; label: (k: string) => string; first: string }) {
  const t = {
    good: sum(rows, (r) => r.goodProduction), plan: sum(rows, (r) => r.plan), loss: sum(rows, (r) => r.lossParts),
    rej: sum(rows, (r) => r.rejectedParts ?? 0), down: sum(rows, (r) => r.downtimeMinutes),
  };
  return (
    <Table
      head={[first, 'Good', 'Plan', 'Ach.', 'Loss', 'Rej', 'Rej %', 'Downtime']}
      rows={rows.map((r) => ({
        key: r.key,
        cells: [
          label(r.key), fmtInt(r.goodProduction), fmtInt(r.plan),
          <span className={achClass(r.achievementPct)}>{fmtPct(r.achievementPct)}</span>,
          fmtInt(r.lossParts), fmtInt(r.rejectedParts), fmtPct(r.rejectionPct), fmtMinutes(r.downtimeMinutes),
        ],
      }))}
      foot={rows.length > 1 ? ['Total', fmtInt(t.good), fmtInt(t.plan), fmtPct(t.plan > 0 ? Math.round((t.good / t.plan) * 1000) / 10 : null), fmtInt(t.loss), fmtInt(t.rej), '', fmtMinutes(t.down)] : undefined}
    />
  );
}

// One row per production day, newest first.
function DayTable({ days, label, recRej }: { days: DaySummary[]; label: (k: string) => string; recRej?: Map<string, number> }) {
  return (
    <Table
      head={['Day', 'Good', 'Plan', 'Ach.', 'Loss', 'Rej', ...(recRej ? ['Rec. rej'] : []), 'Downtime']}
      rows={[...days].reverse().map((d) => ({
        key: d.productionDate,
        today: d.isToday,
        cells: [
          d.isToday ? `${label(d.productionDate)} · today` : label(d.productionDate),
          fmtInt(d.goodProduction), fmtInt(d.plan),
          <span className={achClass(d.achievementPct)}>{fmtPct(d.achievementPct)}</span>,
          fmtInt(d.lossParts), fmtInt(d.rejectedParts),
          ...(recRej ? [fmtInt(recRej.get(d.productionDate) ?? 0)] : []),
          fmtMinutes(d.downtimeMinutes),
        ],
      }))}
    />
  );
}

function StopsTable({ intervals, lineName, dayLabel, max = 25 }: { intervals: DowntimeInterval[]; lineName: (id: string) => string; dayLabel: (k: string) => string; max?: number }) {
  const list = [...intervals].sort((a, b) => Number(b.running) - Number(a.running) || b.minutes - a.minutes).slice(0, max);
  return (
    <Table
      empty="No stops recorded."
      head={['Line', 'Day', 'Shift', 'Reason', 'Duration', 'Status']}
      rows={list.map((iv, i) => ({
        key: `${iv.sessionKey}|${iv.stopId ?? i}`,
        alert: iv.running,
        cells: [
          lineName(iv.lineId ?? '—'), iv.productionDate ? dayLabel(iv.productionDate) : '—', shiftName(iv.shift ?? '—'),
          reasonLabel(iv.reason), fmtMinutes(iv.minutes),
          iv.running ? <b className="ld-crit">Running</b> : 'Ended',
        ],
      }))}
    />
  );
}

function EntriesTable({ entries, lineName, max = 30 }: { entries: RejectionEntry[]; lineName: (id: string) => string; max?: number }) {
  const list = [...entries].sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)).slice(0, max);
  return (
    <Table
      empty="No Record Rejection entries."
      head={['Date', 'Shift', 'Line', 'Part', 'Defect', 'Stage', 'Qty', 'By']}
      rows={list.map((e, i) => ({
        key: `${e.createdAtMs ?? 0}-${i}`,
        cells: [e.date ?? '—', shiftName(e.shift ?? '—'), e.lineName ?? lineName(e.lineId ?? '—'), e.partName ?? '—', e.defect, e.stage ?? '—', fmtInt(e.qty), e.reportedBy ?? '—'],
      }))}
    />
  );
}

// ─── Layout: wide panels full width, the rest in two level columns ───────────

// Height a panel's content needs, ignoring any stretch the layout gives it.
function contentHeight(panel: HTMLElement): number {
  const cs = getComputedStyle(panel);
  const kids = Array.from(panel.children) as HTMLElement[];
  return (
    parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) +
    kids.reduce((n, k) => n + k.offsetHeight, 0) + (parseFloat(cs.rowGap) || 0) * Math.max(0, kids.length - 1)
  );
}

// A run of half-width panels as two columns. Each panel goes to the column
// that is shorter so far (by content height, re-measured as data arrives),
// and the last panel of each column grows so both columns end level — no
// panel reserves space for data it doesn't have, and no gap is left open.
function Columns({ items }: { items: React.ReactElement[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<number[]>(() => items.map((_, i) => i % 2));
  const assign = items.map((_, i) => cols[i] ?? i % 2);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    const panels = () => Array.from(root.querySelectorAll<HTMLElement>('[data-i]'));
    const measure = () => {
      const h: number[] = [];
      panels().forEach((p) => { h[Number(p.dataset.i)] = contentHeight(p.firstElementChild as HTMLElement); });
      const sums = [0, 0];
      const next = items.map((_, i) => {
        const c = sums[1] < sums[0] ? 1 : 0;
        sums[c] += h[i] ?? 0;
        return c;
      });
      setCols((prev) => (prev.length === next.length && prev.every((c, i) => c === next[i]) ? prev : next));
    };
    measure();
    // Watch each panel's content: a stretched panel's own box may not change when its data grows.
    const ro = new ResizeObserver(measure);
    panels().forEach((p) => Array.from((p.firstElementChild as HTMLElement).children).forEach((k) => ro.observe(k)));
    return () => ro.disconnect();
  });

  const column = (c: number) => (
    <div className="ld-dcol">
      {items.map((it, i) => (assign[i] === c ? <div key={it.key ?? i} data-i={i} className="ld-ditem" style={{ order: i }}>{it}</div> : null))}
    </div>
  );
  return <div ref={ref} className="ld-drun">{column(0)}{column(1)}</div>;
}

function PanelLayout({ children }: { children: React.ReactNode }) {
  const flat = React.Children.toArray(React.isValidElement(children) && children.type === React.Fragment ? (children.props as { children: React.ReactNode }).children : children)
    .filter(React.isValidElement) as React.ReactElement<{ wide?: boolean }>[];
  const out: React.ReactNode[] = [];
  let run: React.ReactElement[] = [];
  const flush = () => {
    if (run.length === 1) out.push(<div key={`r${out.length}`} className="ld-ditem">{run[0]}</div>);
    else if (run.length) out.push(<Columns key={`r${out.length}`} items={run} />);
    run = [];
  };
  flat.forEach((el) => {
    if (el.props.wide) {
      flush();
      out.push(<div key={`w${out.length}`} className="ld-ditem">{el}</div>);
    } else run.push(el);
  });
  flush();
  return <div className="ld-dgrid">{out}</div>;
}

const reasonItems = (intervals: DowntimeInterval[]) => downtimeByReason(intervals).map((r) => ({ ...r, label: reasonLabel(r.reason) }));

// ─── The view ─────────────────────────────────────────────────────────────────

export default function DetailView({ data, detail, days, dayLabel, onClose }: {
  data: LiveWeekData; detail: DetailKey; days: DayPoint[]; dayLabel: (k: string) => string; onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const week = data.week!;
  const T = data.todayKey;
  const lineName = (id: string) => data.lineNames[id] ?? (id === '—' ? 'Unknown line' : id);
  const entries = data.rejectionEntries ?? [];

  // Scope: the whole plant, or one line from a Running lines card.
  const lineId = detail.kind === 'line' ? detail.lineId : null;
  const records: DashboardRecord[] = lineId ? week.records.filter((r) => r.lineId === lineId) : week.records;
  const intervals: DowntimeInterval[] = lineId ? week.intervals.filter((iv) => iv.lineId === lineId) : week.intervals;
  const rejAll = lineId ? entries.filter((e) => e.lineId === lineId) : entries;
  const series = lineId ? daySeries(dashboardDays(T), T, records, intervals) : week.days;

  const recsToday = records.filter((r) => r.productionDate === T);
  const ivToday = intervals.filter((iv) => iv.productionDate === T);
  const today = series[series.length - 1];
  const rejToday = rejAll.filter((e) => e.date === data.rejTodayKey);
  const rej7 = rejAll.filter((e) => e.date != null && e.date >= data.rejFromKey);
  const recRejByDay = new Map((data.rejectionDays ?? []).map((d) => [d.date, d.qty]));
  const lineRecRejByDay = lineId
    ? new Map(rejectionsPerDay(rejAll.map((e) => ({ data: { date: e.date, rejectionQty: e.qty } })), dashboardDays(T)).map((d) => [d.date, d.qty]))
    : recRejByDay;

  const byLineToday = productionBreakdown(recsToday, ivToday, 'line');
  const byShiftToday = productionBreakdown(recsToday, ivToday, 'shift');
  const byLineWeek = productionBreakdown(records, intervals, 'line');
  const byShiftWeek = productionBreakdown(records, intervals, 'shift');

  const trend = (title: string) => (
    <DPanel title={title} wide chart>
      <TrendChart
        title="Good production and plan per production day"
        days={days}
        good={series.map((d) => d.goodProduction)}
        plan={series.map((d) => d.plan)}
        achievement={series.map((d) => d.achievementPct)}
        rows={[
          { label: 'Good', values: series.map((d) => fmtInt(d.goodProduction)) },
          { label: 'Ach.', values: series.map((d) => fmtPct(d.achievementPct)) },
        ]}
      />
    </DPanel>
  );
  const dayBars = (title: string, tone: 'reject' | 'loss', unit: string, values: number[], format: (v: number) => string, meta?: React.ReactNode) => (
    <DPanel title={title} meta={meta} wide chart>
      <BarChart title={title} tone={tone} unit={unit} format={format} days={days} values={values} rows={[{ label: unit === 'min' ? 'Time' : 'Pcs', values: values.map(format) }]} />
    </DPanel>
  );
  // Downtime minutes per day as a line, with that day's stop count in the tooltip.
  const downtimeTrend = (title: string) => {
    const stops = new Map<string, number>();
    intervals.forEach((iv) => { if (iv.productionDate) stops.set(iv.productionDate, (stops.get(iv.productionDate) ?? 0) + 1); });
    const values = series.map((d) => Math.round(d.downtimeMinutes));
    return (
      <DPanel title={title} meta={<>Total <b>{fmtMinutes(sum(series, (d) => d.downtimeMinutes))}</b></>} wide chart>
        <LineTrendChart
          title="Downtime"
          tone="loss"
          unit="min"
          format={fmtMinutes}
          days={days}
          values={values}
          extra={(i) => [{ label: 'Stops', value: fmtInt(stops.get(series[i].productionDate) ?? 0) }]}
          rows={[
            { label: 'Time', values: series.map((d) => fmtMinutes(d.downtimeMinutes)) },
            { label: 'Stops', values: series.map((d) => fmtInt(stops.get(d.productionDate) ?? 0)) },
          ]}
        />
      </DPanel>
    );
  };
  const lineBars = (rows: BreakdownRow[], pick: (r: BreakdownRow) => number, format: (v: number) => string, tone: Tone, empty: string, sub?: (r: BreakdownRow) => string) => (
    <HBars tone={tone} empty={empty} total={sum(rows, pick)} rows={rows.map((r) => ({ key: r.key, label: lineName(r.key), sub: sub?.(r), value: pick(r), display: format(pick(r)) })).sort((a, b) => b.value - a.value)} />
  );
  const qtyBars = (items: RejectionEntry[], keyOf: (e: RejectionEntry) => string, label: (k: string) => string = (k) => k, empty = 'No rejections recorded.') => {
    const rows = groupQty(items, keyOf, (e) => e.qty);
    return <HBars tone="reject" empty={empty} total={sum(rows, (r) => r.qty)} rows={rows.map((r) => ({ key: r.key, label: label(r.key), sub: `${r.count} entr${r.count === 1 ? 'y' : 'ies'}`, value: r.qty, display: `${fmtInt(r.qty)} pcs` }))} />;
  };
  const qtyTable = (items: RejectionEntry[], keyOf: (e: RejectionEntry) => string, first: string, label: (k: string) => string = (k) => k) => {
    const rows = groupQty(items, keyOf, (e) => e.qty);
    const total = sum(rows, (r) => r.qty);
    return (
      <Table
        empty="No rejections recorded."
        head={[first, 'Qty', 'Entries', 'Share']}
        rows={rows.map((r) => ({ key: r.key, cells: [label(r.key), fmtInt(r.qty), fmtInt(r.count), total ? `${Math.round((r.qty / total) * 100)}%` : '—'] }))}
      />
    );
  };
  // Line × day heatmaps (every line seen this week, busiest first).
  const weekDays = dashboardDays(T);
  const lineSeries = byLineWeek.map((r) => ({
    key: r.key,
    days: daySeries(weekDays, T, records.filter((x) => (x.lineId ?? '—') === r.key), intervals.filter((iv) => (iv.lineId ?? '—') === r.key)),
  }));
  const heat = (label: string, tone: Tone, format: (v: number) => string, pick: (d: DaySummary) => number | null) => (
    <Heatmap
      label={label} tone={tone} format={format} days={days}
      rows={lineSeries.map((l) => ({ key: l.key, label: lineName(l.key), values: l.days.map((d) => (d.recordCount === 0 && d.downtimeMinutes === 0 ? null : pick(d))) }))}
    />
  );
  const rejHeat = (items: RejectionEntry[]) => {
    const ids = groupQty(items, (e) => e.lineId ?? '—', (e) => e.qty).map((r) => r.key);
    return (
      <Heatmap
        label="Record Rejection qty per line per day" tone="reject" format={fmtInt} days={days}
        rows={ids.map((id) => ({
          key: id, label: lineName(id),
          values: rejectionsPerDay(items.filter((e) => (e.lineId ?? '—') === id).map((e) => ({ data: { date: e.date, rejectionQty: e.qty } })), weekDays).map((d) => (d.count ? d.qty : null)),
        }))}
      />
    );
  };
  const qtyDonut = (items: RejectionEntry[], keyOf: (e: RejectionEntry) => string, centerLabel: string, label: (k: string) => string = (k) => k) => (
    <Donut tone="reject" format={fmtInt} centerLabel={centerLabel} items={groupQty(items, keyOf, (e) => e.qty).map((r) => ({ key: r.key, label: label(r.key), value: r.qty }))} />
  );
  const reasonDonut = (ivs: DowntimeInterval[]) => (
    <Donut tone="loss" format={fmtMinutes} centerLabel="downtime" items={reasonItems(ivs).map((r) => ({ key: r.reason, label: r.label, value: r.minutes }))} />
  );
  const lowest = (rows: BreakdownRow[]) => rows.filter((r) => r.achievementPct != null).sort((a, b) => a.achievementPct! - b.achievementPct!)[0];
  const highest = (rows: BreakdownRow[]) => rows.filter((r) => r.achievementPct != null).sort((a, b) => b.achievementPct! - a.achievementPct!)[0];
  const linesProducing = byLineToday.filter((r) => r.recordCount > 0).length;

  let title = '';
  let scope = '';
  let stats: React.ReactNode = null;
  let body: React.ReactNode = null;

  switch (detail.kind) {
    case 'good':
      title = 'Good production · today';
      scope = `Production day ${dayLabel(T)} · by line and shift`;
      stats = <>
        <Stat label="Good production" value={`${fmtInt(today.goodProduction)} pcs`} sub={`Plan ${fmtInt(today.plan)} pcs`} />
        <Stat label="Achievement" value={fmtPct(today.achievementPct)} sub="Good ÷ plan" />
        <Stat label="Short of plan" value={`${fmtInt(today.lossParts)} pcs`} tone="loss" />
        <Stat label="Lines producing" value={fmtInt(linesProducing)} sub={`${fmtInt(today.recordCount)} hourly entries`} />
      </>;
      body = <>
        <DPanel title="Good production by line · today">{lineBars(byLineToday, (r) => r.goodProduction, (v) => `${fmtInt(v)} pcs`, 'good', 'No production saved today yet.', (r) => `plan ${fmtInt(r.plan)} · ${fmtPct(r.achievementPct)}`)}</DPanel>
        <DPanel title="Share by shift · today"><Donut tone="good" format={fmtInt} centerLabel="pcs good" items={byShiftToday.map((r) => ({ key: r.key, label: shiftName(r.key), value: r.goodProduction }))} /></DPanel>
        <DPanel title="By shift · today" wide><ProductionTable rows={byShiftToday} label={shiftName} first="Shift" /></DPanel>
        <DPanel title="By line · today" wide><ProductionTable rows={byLineToday} label={lineName} first="Line" /></DPanel>
        {trend('Good production · last 7 days')}
      </>;
      break;

    case 'achievement': {
      const lo = lowest(byLineToday);
      const hi = highest(byLineToday);
      title = 'Achievement · today';
      scope = `Production day ${dayLabel(T)} · good ÷ plan per line`;
      stats = <>
        <Stat label="Achievement" value={fmtPct(today.achievementPct)} sub={`${fmtInt(today.goodProduction)} / ${fmtInt(today.plan)} pcs`} />
        <Stat label="Best line" value={hi ? lineName(hi.key) : '—'} sub={hi ? fmtPct(hi.achievementPct) : undefined} />
        <Stat label="Lowest line" value={lo ? lineName(lo.key) : '—'} sub={lo ? fmtPct(lo.achievementPct) : undefined} tone="reject" />
        <Stat label="7-day achievement" value={fmtPct(week.totals.achievementPct)} />
      </>;
      body = <>
        <DPanel title="Achievement by line · today">
          <HBars tone="good" empty="No plan recorded today yet." rows={byLineToday.filter((r) => r.achievementPct != null).sort((a, b) => b.achievementPct! - a.achievementPct!).map((r) => ({ key: r.key, label: lineName(r.key), sub: `${fmtInt(r.goodProduction)} / ${fmtInt(r.plan)} pcs`, value: r.achievementPct!, display: fmtPct(r.achievementPct) }))} />
        </DPanel>
        <DPanel title="By shift · today"><ProductionTable rows={byShiftToday} label={shiftName} first="Shift" /></DPanel>
        {trend('Achievement · last 7 days')}
        <DPanel title="Achievement heatmap · line × day" wide>{heat('Achievement per line per day', 'good', (v) => `${Math.round(v)}%`, (d) => d.achievementPct)}</DPanel>
        <DPanel title="Per day" wide><DayTable days={series} label={dayLabel} /></DPanel>
      </>;
      break;
    }

    case 'rejToday':
      title = 'Rejections · today';
      scope = `Production day ${dayLabel(T)} · production counter and Record Rejection entries`;
      stats = <>
        <Stat label="Rejected (counter)" value={`${fmtInt(today.rejectedParts)} pcs`} sub={`Rate ${fmtPct(today.rejectionPct)}`} tone="reject" />
        <Stat label="Quality" value={fmtPct(today.qualityPct)} />
        <Stat label="Record Rejection · today" value={`${fmtInt(sum(rejToday, (e) => e.qty))} pcs`} sub={`${rejToday.length} entries`} tone="reject" />
        <Stat label="Top defect · today" value={groupQty(rejToday, (e) => e.defect, (e) => e.qty)[0]?.key ?? '—'} tone="reject" />
      </>;
      body = <>
        <DPanel title="Rejected parts by line · today (counter)">{lineBars(byLineToday, (r) => r.rejectedParts ?? 0, (v) => `${fmtInt(v)} pcs`, 'reject', 'No rejections counted today.', (r) => `rate ${fmtPct(r.rejectionPct)}`)}</DPanel>
        <DPanel title="Defects · today (Record Rejection)">{qtyBars(rejToday, (e) => e.defect)}</DPanel>
        <DPanel title="By shift · today"><ProductionTable rows={byShiftToday} label={shiftName} first="Shift" /></DPanel>
        <DPanel title="By stage · today (Record Rejection)">{qtyDonut(rejToday, (e) => e.stage ?? 'Unspecified', 'pcs rejected')}</DPanel>
        <DPanel title="By part · today (Record Rejection)">{qtyTable(rejToday, (e) => e.partName ?? 'Unknown part', 'Part')}</DPanel>
        <DPanel title="Today's Record Rejection entries" wide><EntriesTable entries={rejToday} lineName={lineName} /></DPanel>
      </>;
      break;

    case 'lossToday':
      title = 'Production loss · today';
      scope = `Production day ${dayLabel(T)} · parts short of plan`;
      stats = <>
        <Stat label="Loss" value={`${fmtInt(today.lossParts)} pcs`} sub={today.plan ? `${fmtPct(Math.round((today.lossParts / today.plan) * 1000) / 10)} of plan` : undefined} tone="loss" />
        <Stat label="Plan" value={`${fmtInt(today.plan)} pcs`} />
        <Stat label="Good production" value={`${fmtInt(today.goodProduction)} pcs`} />
        <Stat label="Downtime" value={fmtMinutes(today.downtimeMinutes)} tone="loss" />
      </>;
      body = <>
        <DPanel title="Loss by line · today">{lineBars(byLineToday, (r) => r.lossParts, (v) => `${fmtInt(v)} pcs`, 'loss', 'No loss today.', (r) => `downtime ${fmtMinutes(r.downtimeMinutes)}`)}</DPanel>
        <DPanel title="By shift · today"><ProductionTable rows={byShiftToday} label={shiftName} first="Shift" /></DPanel>
        {dayBars('Production loss · last 7 days', 'loss', 'pcs', series.map((d) => d.lossParts), fmtInt)}
        <DPanel title="Downtime by reason · today"><ReasonBars items={reasonItems(ivToday)} total={today.downtimeMinutes} max={12} /></DPanel>
        <DPanel title="By line · today"><ProductionTable rows={byLineToday} label={lineName} first="Line" /></DPanel>
      </>;
      break;

    case 'downtimeToday':
      title = 'Downtime · today';
      scope = `Production day ${dayLabel(T)} · every stop, by reason and line`;
      stats = <>
        <Stat label="Downtime" value={fmtMinutes(today.downtimeMinutes)} tone="loss" />
        <Stat label="Stops" value={fmtInt(ivToday.length)} sub={`${ivToday.filter((iv) => iv.running).length} running now`} tone="loss" />
        <Stat label="Lines affected" value={fmtInt(new Set(ivToday.map((iv) => iv.lineId)).size)} />
        <Stat label="Top reason" value={reasonItems(ivToday)[0]?.label ?? '—'} tone="loss" />
      </>;
      body = <>
        <DPanel title="By reason · today"><ReasonBars items={reasonItems(ivToday)} total={today.downtimeMinutes} max={12} /></DPanel>
        <DPanel title="Share by reason · today">{reasonDonut(ivToday)}</DPanel>
        <DPanel title="By line · today">{lineBars(byLineToday, (r) => r.downtimeMinutes, fmtMinutes, 'loss', 'No downtime today.')}</DPanel>
        <DPanel title="Stops · today" wide><StopsTable intervals={ivToday} lineName={lineName} dayLabel={dayLabel} /></DPanel>
        {downtimeTrend('Downtime trend · last 7 days')}
        <DPanel title="By shift · today" wide><ProductionTable rows={byShiftToday} label={shiftName} first="Shift" /></DPanel>
      </>;
      break;

    case 'week':
    case 'trend':
      title = detail.kind === 'week' ? 'Last 7 days' : 'Production trend · last 7 days';
      scope = `${dayLabel(data.fromKey)} – ${dayLabel(T)} · per day, line and shift`;
      stats = <>
        <Stat label="Good production" value={`${fmtInt(week.totals.goodProduction)} pcs`} sub={`Plan ${fmtInt(week.totals.plan)} pcs`} />
        <Stat label="Achievement" value={fmtPct(week.totals.achievementPct)} />
        <Stat label="Rejected (counter)" value={`${fmtInt(week.totals.rejectedParts)} pcs`} sub={`Rate ${fmtPct(week.totals.rejectionPct)}`} tone="reject" />
        <Stat label="Loss" value={`${fmtInt(week.totals.lossParts)} pcs`} tone="loss" />
        <Stat label="Downtime" value={fmtMinutes(week.totals.downtimeMinutes)} tone="loss" />
      </>;
      body = <>
        {trend('Good production and plan')}
        <DPanel title="Per day" wide><DayTable days={series} label={dayLabel} recRej={recRejByDay} /></DPanel>
        <DPanel title="Good production heatmap · line × day" wide>{heat('Good production per line per day', 'good', fmtInt, (d) => d.goodProduction)}</DPanel>
        <DPanel title="By line · 7 days" wide><ProductionTable rows={byLineWeek} label={lineName} first="Line" /></DPanel>
        <DPanel title="Share by shift · 7 days"><Donut tone="good" format={fmtInt} centerLabel="pcs good" items={byShiftWeek.map((r) => ({ key: r.key, label: shiftName(r.key), value: r.goodProduction }))} /></DPanel>
        <DPanel title="Downtime share by reason · 7 days">{reasonDonut(intervals)}</DPanel>
        <DPanel title="By shift · 7 days" wide><ProductionTable rows={byShiftWeek} label={shiftName} first="Shift" /></DPanel>
      </>;
      break;

    case 'planActual': {
      const cw = week.calendarWeek;
      const monday = cw.days[0].productionDate;
      const wtdRecs = records.filter((r) => r.productionDate != null && r.productionDate >= monday);
      const wtdIv = intervals.filter((iv) => iv.productionDate != null && iv.productionDate >= monday);
      title = 'Plan vs actual · this week';
      scope = `Week of ${dayLabel(monday)} · Monday to Sunday`;
      stats = <>
        <Stat label="Actual" value={`${fmtInt(cw.totals.goodProduction)} pcs`} />
        <Stat label="Plan to date" value={`${fmtInt(cw.totals.plan)} pcs`} />
        <Stat label="Achievement" value={fmtPct(cw.totals.achievementPct)} />
        <Stat label="Variance" value={`${cw.totals.goodProduction - cw.totals.plan >= 0 ? '+' : '−'}${fmtInt(Math.abs(cw.totals.goodProduction - cw.totals.plan))} pcs`} tone={cw.totals.goodProduction >= cw.totals.plan ? 'good' : 'loss'} />
      </>;
      body = <>
        <DPanel title="Plan vs actual per day" wide chart>
          <PlanActualChart
            title="Plan versus actual good production per day, this week"
            days={cw.days.map((d) => ({ key: d.productionDate, label: dayLabel(d.productionDate), isToday: d.isToday }))}
            plan={cw.days.map((d) => d.plan)}
            actual={cw.days.map((d) => d.goodProduction)}
            achievement={cw.days.map((d) => d.achievementPct)}
            future={cw.days.map((d) => d.isFuture)}
          />
        </DPanel>
        <DPanel title="Per day">
          <Table
            head={['Day', 'Plan', 'Actual', 'Variance', 'Ach.']}
            rows={cw.days.map((d) => ({
              key: d.productionDate, today: d.isToday,
              cells: d.isFuture
                ? [dayLabel(d.productionDate), '—', '—', '—', '—']
                : [dayLabel(d.productionDate), fmtInt(d.plan), fmtInt(d.goodProduction), fmtInt((d.goodProduction ?? 0) - (d.plan ?? 0)), <span className={achClass(d.achievementPct)}>{fmtPct(d.achievementPct)}</span>],
            }))}
          />
        </DPanel>
        <DPanel title="By line · week to date"><ProductionTable rows={productionBreakdown(wtdRecs, wtdIv, 'line')} label={lineName} first="Line" /></DPanel>
      </>;
      break;
    }

    case 'stopped': {
      const stopped = data.stopped ?? [];
      const running = intervals.filter((iv) => iv.running);
      title = 'Stopped lines · now';
      scope = 'Lines stopped right now and today’s stops';
      stats = <>
        <Stat label="Stopped now" value={`${stopped.length} of ${data.activeLineCount}`} sub="live lines" tone={stopped.length ? 'reject' : 'good'} />
        <Stat label="Stops running" value={fmtInt(running.length)} tone="loss" />
        <Stat label="Downtime · today" value={fmtMinutes(today.downtimeMinutes)} tone="loss" />
        <Stat label="Stops · today" value={fmtInt(ivToday.length)} tone="loss" />
      </>;
      body = <>
        <DPanel title="Stopped right now" wide>
          <Table
            empty="Every live line is running."
            head={['Line', 'Plant', 'Shift', 'Reason', 'Stopped since', 'For']}
            rows={stopped.map((l) => ({
              key: l.lineId, alert: true,
              cells: [l.lineName, l.plant ?? '—', shiftName(l.shift ?? '—'), l.reason ?? 'Not recorded',
                l.sinceMs ? new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date(l.sinceMs)) : '—',
                l.sinceMs ? fmtMinutes((data.nowMs - l.sinceMs) / 60000) : '—'],
            }))}
          />
        </DPanel>
        <DPanel title="Downtime by line · today">{lineBars(byLineToday, (r) => r.downtimeMinutes, fmtMinutes, 'loss', 'No downtime today.')}</DPanel>
        <DPanel title="By reason · today"><ReasonBars items={reasonItems(ivToday)} total={today.downtimeMinutes} max={12} /></DPanel>
        <DPanel title="Stops · today" wide><StopsTable intervals={ivToday} lineName={lineName} dayLabel={dayLabel} /></DPanel>
      </>;
      break;
    }

    case 'rejPerDay': {
      const rd = data.rejectionDays ?? [];
      const total = sum(rd, (d) => d.qty);
      const worst = [...rd].sort((a, b) => b.qty - a.qty)[0];
      title = 'Rejections per day';
      scope = `${dayLabel(data.fromKey)} – ${dayLabel(T)} · Record Rejection entries (quality incharge)`;
      stats = <>
        <Stat label="Rejected · 7 days" value={`${fmtInt(total)} pcs`} sub={`${fmtInt(rejAll.length)} entries`} tone="reject" />
        <Stat label="Average per day" value={`${fmtInt(total / Math.max(1, rd.length))} pcs`} tone="reject" />
        <Stat label="Worst day" value={worst && worst.qty ? dayLabel(worst.date) : '—'} sub={worst && worst.qty ? `${fmtInt(worst.qty)} pcs` : undefined} tone="reject" />
        <Stat label="Today" value={`${fmtInt(rd[rd.length - 1]?.qty ?? 0)} pcs`} tone="reject" />
      </>;
      body = <>
        {dayBars('Rejected parts per day', 'reject', 'pcs', rd.map((d) => d.qty), fmtInt, <>Total <b>{fmtInt(total)}</b> pcs</>)}
        <DPanel title="Per day">
          <Table
            head={['Day', 'Qty', 'Entries', 'Rate']}
            rows={[...rd].reverse().map((d, i) => {
              const day = week.days[rd.length - 1 - i];
              return { key: d.date, today: day?.isToday, cells: [dayLabel(d.date), fmtInt(d.qty), fmtInt(d.count), fmtPct(rejRate(d.qty, day?.goodProduction ?? 0))] };
            })}
          />
        </DPanel>
        <DPanel title="Rejection heatmap · line × day" wide>{rejHeat(rejAll)}</DPanel>
        <DPanel title="By line · 7 days">{qtyBars(rejAll, (e) => e.lineId ?? '—', lineName)}</DPanel>
        <DPanel title="By shift · 7 days">{qtyDonut(rejAll, (e) => e.shift ?? '—', 'pcs rejected', shiftName)}</DPanel>
        <DPanel title="By part · 7 days">{qtyTable(rejAll, (e) => e.partName ?? 'Unknown part', 'Part')}</DPanel>
      </>;
      break;
    }

    case 'rejTypes': {
      const defects = groupQty(rej7, (e) => e.defect, (e) => e.qty);
      const total = sum(defects, (r) => r.qty);
      title = 'Types of rejection · 7 days';
      scope = `${dayLabel(data.rejFromKey)} – ${dayLabel(data.rejTodayKey)} · Record Rejection entries`;
      stats = <>
        <Stat label="Rejected" value={`${fmtInt(total)} pcs`} sub={`${fmtInt(rej7.length)} entries`} tone="reject" />
        <Stat label="Defect types" value={fmtInt(defects.length)} tone="reject" />
        <Stat label="Top defect" value={defects[0]?.key ?? '—'} sub={defects[0] && total ? `${Math.round((defects[0].qty / total) * 100)}% of all` : undefined} tone="reject" />
        <Stat label="Top stage" value={groupQty(rej7, (e) => e.stage ?? 'Unspecified', (e) => e.qty)[0]?.key ?? '—'} tone="reject" />
      </>;
      body = <>
        <DPanel title="Every defect">{qtyBars(rej7, (e) => e.defect)}</DPanel>
        <DPanel title="By stage">{qtyDonut(rej7, (e) => e.stage ?? 'Unspecified', 'pcs rejected')}</DPanel>
        <DPanel title="By line">{qtyBars(rej7, (e) => e.lineId ?? '—', lineName)}</DPanel>
        <DPanel title="By part">{qtyTable(rej7, (e) => e.partName ?? 'Unknown part', 'Part')}</DPanel>
        <DPanel title="Latest entries" wide><EntriesTable entries={rej7} lineName={lineName} /></DPanel>
      </>;
      break;
    }

    case 'lossPerDay':
      title = 'Production loss per day';
      scope = `${dayLabel(data.fromKey)} – ${dayLabel(T)} · parts short of plan`;
      stats = <>
        <Stat label="Loss · 7 days" value={`${fmtInt(week.totals.lossParts)} pcs`} sub={week.totals.plan ? `${fmtPct(Math.round((week.totals.lossParts / week.totals.plan) * 1000) / 10)} of plan` : undefined} tone="loss" />
        <Stat label="Plan · 7 days" value={`${fmtInt(week.totals.plan)} pcs`} />
        <Stat label="Downtime · 7 days" value={fmtMinutes(week.totals.downtimeMinutes)} tone="loss" />
        <Stat label="Today" value={`${fmtInt(today.lossParts)} pcs`} tone="loss" />
      </>;
      body = <>
        {dayBars('Loss per day', 'loss', 'pcs', series.map((d) => d.lossParts), fmtInt)}
        <DPanel title="Loss heatmap · line × day" wide>{heat('Production loss per line per day', 'loss', fmtInt, (d) => d.lossParts)}</DPanel>
        <DPanel title="By line · 7 days">{lineBars(byLineWeek, (r) => r.lossParts, (v) => `${fmtInt(v)} pcs`, 'loss', 'No loss in the last 7 days.', (r) => `plan ${fmtInt(r.plan)}`)}</DPanel>
        <DPanel title="By shift · 7 days"><ProductionTable rows={byShiftWeek} label={shiftName} first="Shift" /></DPanel>
        <DPanel title="Per day" wide><DayTable days={series} label={dayLabel} /></DPanel>
      </>;
      break;

    case 'downtime':
      title = 'Downtime · last 7 days';
      scope = `${dayLabel(data.fromKey)} – ${dayLabel(T)} · by reason, day, line and shift`;
      stats = <>
        <Stat label="Downtime" value={fmtMinutes(week.totals.downtimeMinutes)} tone="loss" />
        <Stat label="Stops" value={fmtInt(intervals.length)} sub={`${week.runningStops} running now`} tone="loss" />
        <Stat label="Top reason" value={week.downtimeReasons[0]?.label ?? '—'} sub={week.downtimeReasons[0] ? fmtMinutes(week.downtimeReasons[0].minutes) : undefined} tone="loss" />
        <Stat label="Average per day" value={fmtMinutes(week.totals.downtimeMinutes / series.length)} tone="loss" />
      </>;
      body = <>
        {downtimeTrend('Downtime trend · 7 days')}
        <DPanel title="Downtime heatmap · line × day" wide>{heat('Downtime per line per day', 'loss', fmtMinutes, (d) => d.downtimeMinutes)}</DPanel>
        <DPanel title="By reason"><ReasonBars items={week.downtimeReasons} total={week.totals.downtimeMinutes} max={14} /></DPanel>
        <DPanel title="Share by reason">{reasonDonut(intervals)}</DPanel>
        <DPanel title="By line">{lineBars(byLineWeek, (r) => r.downtimeMinutes, fmtMinutes, 'loss', 'No downtime in the last 7 days.')}</DPanel>
        <DPanel title="By shift"><ProductionTable rows={byShiftWeek} label={shiftName} first="Shift" /></DPanel>
        <DPanel title="Longest stops"><StopsTable intervals={intervals} lineName={lineName} dayLabel={dayLabel} max={15} /></DPanel>
      </>;
      break;

    case 'line': {
      const live = data.lines?.find((l) => l.card.lineId === detail.lineId);
      const totals = productionBreakdown(records, intervals, 'line')[0];
      title = lineName(detail.lineId);
      scope = [live?.card.model, live ? `Shift ${live.card.shift}` : null, live?.plant, 'last 7 days'].filter(Boolean).join(' · ');
      stats = <>
        <Stat label="Good · today" value={`${fmtInt(today.goodProduction)} pcs`} sub={`Plan ${fmtInt(today.plan)} · ${fmtPct(today.achievementPct)}`} />
        {live ? <Stat label="This shift" value={`${fmtInt(live.card.actual)} / ${fmtInt(live.card.planToDate)}`} sub={`Achievement ${fmtPct(live.achievementPct)}`} /> : null}
        <Stat label="Rejections · today" value={`${fmtInt(today.rejectedParts)} pcs`} sub={`Record Rejection ${fmtInt(sum(rejToday, (e) => e.qty))} pcs`} tone="reject" />
        <Stat label="Downtime · today" value={fmtMinutes(today.downtimeMinutes)} sub={live?.stop ? `Stopped: ${live.stop.reason ?? 'reason not recorded'}` : undefined} tone="loss" />
        <Stat label="7-day achievement" value={fmtPct(totals?.achievementPct ?? null)} sub={`${fmtInt(totals?.goodProduction ?? 0)} pcs`} />
      </>;
      body = <>
        {trend('Good production and plan · this line')}
        {downtimeTrend('Downtime trend · this line')}
        <DPanel title="Downtime by reason · 7 days"><ReasonBars items={reasonItems(intervals)} total={sum(intervals, (iv) => iv.minutes)} max={12} /></DPanel>
        <DPanel title="Defects · 7 days (Record Rejection)">{qtyBars(rej7, (e) => e.defect)}</DPanel>
        <DPanel title="Per day" wide><DayTable days={series} label={dayLabel} recRej={lineRecRejByDay} /></DPanel>
        <DPanel title="By shift · 7 days"><ProductionTable rows={byShiftWeek} label={shiftName} first="Shift" /></DPanel>
        <DPanel title="Stops · 7 days"><StopsTable intervals={intervals} lineName={lineName} dayLabel={dayLabel} max={15} /></DPanel>
      </>;
      break;
    }
  }

  return (
    <div className="ld-detail" role="dialog" aria-modal="true" aria-label={`${title} — detailed analysis`}>
      <header className="ld-detail__head">
        <button ref={closeRef} className="ld-detail__back" onClick={onClose} aria-label="Back to dashboard (Esc)">
          <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          Back
        </button>
        <div className="ld-detail__titles">
          <h1 className="ld-detail__title">{title}</h1>
          <div className="ld-detail__scope">{scope}</div>
        </div>
        <span className="ld-detail__hint">Esc to close · updates live</span>
      </header>
      <div className="ld-detail__body">
        <div className="ld-dstats">{stats}</div>
        <PanelLayout>{body}</PanelLayout>
      </div>
    </div>
  );
}
