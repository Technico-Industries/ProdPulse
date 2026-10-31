// src/liveDashboard/LiveDashboardView.tsx
//
// The web Live Dashboard page — plain React DOM + CSS + SVG (no React
// Native), laid out for a 1920×1080 TV: every size is in em off a
// viewport-scaled root, so it fills any 16:9 screen without scrolling.
// Display only: every figure comes from useLiveWeekData / utils/liveDashboard;
// charts.tsx animates the transitions between live updates.

import React, { useCallback, useEffect, useState } from 'react';
import type { LiveWeekData } from './useLiveWeekData';
import {
  AnimatedNumber, BarChart, DayPoint, Gauge, LineTrendChart, PlanActualChart, ReasonBars, RejectionTypeBars, RotatingPanel,
  Sparkline, StoppedLinesBoard, TrendChart, fmtInt, fmtMinutes, fmtPct, openProps, useFlash,
} from './charts';
import DetailView, { DetailKey } from './DetailView';
import { LIVE_DASHBOARD_CSS } from './styles';
import Pager from './Pager';
import RunningLinesPage from './RunningLinesPage';

// Page order: the Overview is the main screen and always opens first;
// Running lines sits to its RIGHT, so swiping left on the overview opens it.
const PAGES = ['Overview', 'Running lines'] as const;

const TZ = 'Asia/Kolkata';

function dayLabel(key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: '2-digit' }) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  // A production date is a calendar label, not an instant: format in UTC.
  return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}

// Record Rejection qty as a share of that day's parts (good + rejected).
const rejRate = (rejected: number, good: number) =>
  good + rejected > 0 ? Math.round((rejected / (good + rejected)) * 1000) / 10 : null;

const clock = (ms: number, seconds = true) =>
  new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false, timeZone: TZ }).format(new Date(ms));

// Ticks on its own, so the charts don't re-render every second.
function Clock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="ld-clock" aria-label="Plant time (IST)">{clock(now)}</span>;
}

function FullscreenButton() {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  return (
    <button className="ld-iconbtn" onClick={toggle} title={on ? 'Exit full screen' : 'Full screen'} aria-label={on ? 'Exit full screen' : 'Full screen'}>
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        {on ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  );
}

function Kpi({ label, value, flashKey, sub, alert, tone, spark, children, onOpen }: {
  label: string; value?: React.ReactNode; flashKey: unknown; sub?: React.ReactNode; alert?: boolean;
  tone: 'good' | 'reject' | 'loss'; spark?: number[]; children?: React.ReactNode; onOpen?: () => void;
}) {
  const flash = useFlash(flashKey);
  return (
    <section className={`ld-kpi ld-kpi--${tone}${alert ? ' ld-kpi--alert' : ''}${flash ? ' is-updated' : ''}${onOpen ? ' is-clickable' : ''}`} {...openProps(onOpen, label)}>
      <h2 className="ld-kpi__label">{label}</h2>
      {value != null ? <div className="ld-kpi__value">{value}</div> : null}
      {children}
      {sub ? <div className="ld-kpi__sub">{sub}</div> : null}
      {spark ? <Sparkline values={spark} tone={tone} /> : null}
    </section>
  );
}

function Panel({ title, legend, meta, children, className = '', onOpen }: { title: string; legend?: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode; className?: string; onOpen?: () => void }) {
  return (
    <section className={`ld-panel ${className}${onOpen ? ' is-clickable' : ''}`} {...openProps(onOpen, title)}>
      <header className="ld-panel__head">
        <h2 className="ld-panel__title">{title}</h2>
        {legend ?? (meta ? <span className="ld-panel__meta">{meta}</span> : null)}
      </header>
      {children}
    </section>
  );
}

// Scrolling strip of the latest live events: lines stopped right now and
// today's Record Rejection entries, newest first. Pauses on hover.
function Ticker({ data }: { data: LiveWeekData }) {
  const items: { key: string; at: number; node: React.ReactNode }[] = [];
  (data.stopped ?? []).forEach((l) => items.push({
    key: `s-${l.lineId}`,
    at: l.sinceMs ?? 0,
    node: <><i className="ld-ticker__dot ld-ticker__dot--stop" /><b>{l.lineName}</b> stopped · {l.reason ?? 'reason not recorded'}{l.sinceMs ? <time>since {clock(l.sinceMs, false)}</time> : null}</>,
  }));
  (data.rejectionEntries ?? [])
    .filter((e) => e.date === data.rejTodayKey && e.qty > 0)
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    .slice(0, 12)
    .forEach((e, i) => items.push({
      key: `r-${e.createdAtMs ?? 0}-${i}`,
      at: e.createdAtMs ?? 0,
      node: <><i className="ld-ticker__dot ld-ticker__dot--reject" /><b>{e.lineName ?? (e.lineId ? data.lineNames[e.lineId] ?? e.lineId : 'Unknown line')}</b>{e.partName ? ` · ${e.partName}` : ''} · {e.defect} <b>{fmtInt(e.qty)} pcs</b>{e.createdAtMs ? <time>{clock(e.createdAtMs, false)}</time> : null}</>,
    }));
  items.sort((a, b) => b.at - a.at);
  return (
    <div className="ld-ticker" aria-label="Latest events">
      <span className="ld-ticker__tag"><i aria-hidden="true" />LIVE FEED</span>
      {items.length ? (
        <div className="ld-ticker__view">
          <div className="ld-ticker__track" style={{ animationDuration: `${Math.max(30, items.length * 9)}s` }}>
            {items.map((it) => <span key={it.key} className="ld-ticker__item">{it.node}</span>)}
          </div>
        </div>
      ) : (
        <span className="ld-ticker__calm">All live lines running · no rejections logged today</span>
      )}
    </div>
  );
}

function StateScreen({ tone, title, body, spinner }: { tone: 'neutral' | 'critical'; title: string; body: string; spinner?: boolean }) {
  return (
    <div className={`ld-state ld-state--${tone}`} role={tone === 'critical' ? 'alert' : 'status'}>
      {spinner ? <div className="ld-spinner" aria-hidden="true" /> : <div className="ld-state__mark" aria-hidden="true" />}
      <h1 className="ld-state__title">{title}</h1>
      <p className="ld-state__body">{body}</p>
    </div>
  );
}

export default function LiveDashboardView({ data, deniedMessage }: { data: LiveWeekData | null; deniedMessage?: string }) {
  const week = data?.week ?? null;
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<DetailKey | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  const open = (kind: Exclude<DetailKey['kind'], 'line'>) => () => setDetail({ kind } as DetailKey);
  const paged = !deniedMessage && !!data && data.status === 'ready' && !!week;
  const live = data && data.status === 'ready' && !data.reconnecting;

  let body: React.ReactNode;
  if (deniedMessage) {
    body = <StateScreen tone="critical" title="Admins only" body={deniedMessage} />;
  } else if (!data || data.status === 'loading') {
    body = <StateScreen tone="neutral" spinner title="Connecting to live production data…" body="Loading the last 7 production days." />;
  } else if (data.status === 'error' || !week) {
    body = data.errorCode === 'permission-denied'
      ? <StateScreen tone="critical" title="No access to production data" body="Firestore did not allow this account to read production records. Sign in with an admin account." />
      : <StateScreen tone="critical" title="Cannot load production data" body={`The live connection failed (${data.errorCode ?? 'unknown error'}). Retrying automatically every 15 seconds.`} />;
  } else {
    const days: DayPoint[] = week.days.map((d) => ({ key: d.productionDate, label: dayLabel(d.productionDate), isToday: d.isToday }));
    const today = week.days[week.days.length - 1];
    const empty = week.totals.recordCount === 0 && week.totals.downtimeMinutes === 0;
    const cw = week.calendarWeek;
    const rt = data.rejectionTypes;
    const rd = data.rejectionDays;
    const series = <K extends keyof (typeof week.days)[number]>(k: K) => week.days.map((d) => (typeof d[k] === 'number' ? (d[k] as number) : 0));

    body = (
      <>
        <div className="ld-banners" role="status" aria-live="polite">
          {data.reconnecting ? <div className="ld-banner ld-banner--critical"><b>!</b>Connection lost — showing the last data received. Reconnecting…</div> : null}
          {data.failedSources.some((n) => n !== 'rejectionRecords') ? (
            <div className="ld-banner ld-banner--warning"><b>!</b>Downtime / stopped lines may be incomplete — could not read {data.failedSources.filter((n) => n !== 'rejectionRecords').join(', ')}.</div>
          ) : null}
          {data.failedSources.includes('rejectionRecords') ? (
            <div className="ld-banner ld-banner--warning"><b>!</b>Rejections per day / types of rejection unavailable — could not read rejectionRecords.</div>
          ) : null}
          {empty ? <div className="ld-banner ld-banner--info"><b>i</b>No production recorded in the last 7 production days yet. The charts update automatically as soon as data arrives.</div> : null}
        </div>

        <Pager
          index={page}
          onIndex={setPage}
          keyboard={!detail}
          pages={[
            <React.Fragment key="overview">
        <div className="ld-kpis">
          <Kpi
            onOpen={open('good')} tone="good" label="Good production · today" flashKey={today.goodProduction} spark={series('goodProduction')}
            value={<><AnimatedNumber value={today.goodProduction} format={fmtInt} /><small>pcs</small></>}
            sub={<>Plan <b>{fmtInt(today.plan)}</b> pcs</>}
          />
          <Kpi onOpen={open('achievement')} tone="good" label="Achievement · today" flashKey={today.achievementPct} sub="Good ÷ plan">
            <Gauge pct={today.achievementPct} />
          </Kpi>
          <Kpi
            onOpen={open('rejToday')} tone="reject" label="Rejections · today" flashKey={today.rejectedParts} spark={series('rejectedParts')}
            value={<><AnimatedNumber value={today.rejectedParts} format={fmtInt} /><small>pcs</small></>}
            sub={<>Rate <b>{fmtPct(today.rejectionPct)}</b> · Quality <b>{fmtPct(today.qualityPct)}</b></>}
          />
          <Kpi
            onOpen={open('lossToday')} tone="loss" label="Production loss · today" flashKey={today.lossParts} spark={series('lossParts')}
            value={<><AnimatedNumber value={today.lossParts} format={fmtInt} /><small>pcs</small></>}
            sub="Parts short of plan"
          />
          <Kpi
            onOpen={open('downtimeToday')} tone="loss" label="Downtime · today" flashKey={Math.round(today.downtimeMinutes)} spark={series('downtimeMinutes')}
            alert={week.runningStops > 0}
            value={<AnimatedNumber value={today.downtimeMinutes} format={fmtMinutes} />}
            sub={week.runningStops ? <span className="ld-running"><i />{week.runningStops} stop{week.runningStops === 1 ? '' : 's'} running now</span> : 'No line stopped'}
          />
          <Kpi
            onOpen={open('week')} tone="good" label="Last 7 days" flashKey={week.totals.goodProduction} spark={series('achievementPct')}
            value={<><AnimatedNumber value={week.totals.goodProduction} format={fmtInt} /><small>pcs</small></>}
            sub={<>Achievement <b>{fmtPct(week.totals.achievementPct)}</b> · Rej <b>{fmtInt(week.totals.rejectedParts)}</b></>}
          />
        </div>

        <div className="ld-grid">
          <Panel
            className="ld-span2"
            title="Production trend · last 7 days"
            onOpen={open('trend')}
            legend={
              <span className="ld-legend">
                <span><i className="ld-sw ld-sw--good" />Good production</span>
                <span><i className="ld-sw ld-sw--plan" />Plan</span>
                <span><i className="ld-sw ld-sw--today" />Today (in progress)</span>
              </span>
            }
          >
            <TrendChart
              title="Good production and plan per production day, last 7 days"
              days={days}
              good={series('goodProduction')}
              plan={series('plan')}
              achievement={week.days.map((d) => d.achievementPct)}
              rows={[
                { label: 'Good', values: week.days.map((d) => fmtInt(d.goodProduction)) },
                { label: 'Plan', values: week.days.map((d) => fmtInt(d.plan)) },
                { label: 'Ach.', values: week.days.map((d) => fmtPct(d.achievementPct)) },
              ]}
            />
          </Panel>

          <Panel
            title="Plan vs actual · this week"
            onOpen={open('planActual')}
            legend={
              <span className="ld-legend ld-legend--sm">
                <span><i className="ld-sw ld-sw--box ld-sw--planbox" />Plan</span>
                <span><i className="ld-sw ld-sw--box ld-sw--goodbox" />Actual</span>
              </span>
            }
          >
            <div className="ld-panel__sub">
              Week to date <b>{fmtInt(cw.totals.goodProduction)}</b> / {fmtInt(cw.totals.plan)} pcs · <b className="ld-accent">{fmtPct(cw.totals.achievementPct)}</b>
            </div>
            <PlanActualChart
              title="Plan versus actual good production per day, this week"
              days={cw.days.map((d) => ({ key: d.productionDate, label: dayLabel(d.productionDate, { weekday: 'short' }), isToday: d.isToday }))}
              plan={cw.days.map((d) => d.plan)}
              actual={cw.days.map((d) => d.goodProduction)}
              achievement={cw.days.map((d) => d.achievementPct)}
              future={cw.days.map((d) => d.isFuture)}
            />
          </Panel>

          <Panel
            className={data.stopped?.length ? 'ld-panel--alert' : ''}
            title="Stopped lines · now"
            onOpen={open('stopped')}
            meta={data.stopped ? <><b className={data.stopped.length ? 'ld-crit' : 'ld-ok'}>{data.stopped.length}</b> of {data.activeLineCount} live</> : undefined}
          >
            {data.stopped ? <StoppedLinesBoard lines={data.stopped} activeCount={data.activeLineCount} /> : <div className="ld-empty">Loading live lines…</div>}
          </Panel>

          <Panel onOpen={open('rejPerDay')} title="Rejections per day" meta={rd ? <>Total <b>{fmtInt(rd.reduce((n, d) => n + d.qty, 0))}</b> pcs</> : 'Record Rejection'}>
            {rd ? (
              <>
                <BarChart
                  title="Rejected parts"
                  tone="reject"
                  unit="pcs"
                  format={(v) => fmtInt(v)}
                  days={days}
                  values={rd.map((d) => d.qty)}
                  extra={(i) => [
                    { label: 'Entries', value: fmtInt(rd[i].count) },
                    { label: 'Rejection rate', value: fmtPct(rejRate(rd[i].qty, week.days[i].goodProduction)) },
                  ]}
                  rows={[
                    { label: 'Pcs', values: rd.map((d) => fmtInt(d.qty)) },
                    { label: 'Rate', values: rd.map((d, i) => fmtPct(rejRate(d.qty, week.days[i].goodProduction))) },
                  ]}
                />
                <div className="ld-note">From Record Rejection entries (quality incharge)</div>
              </>
            ) : data.failedSources.includes('rejectionRecords') ? (
              <div className="ld-empty">Rejections unavailable.</div>
            ) : (
              <div className="ld-empty">Loading rejections…</div>
            )}
          </Panel>

          <Panel onOpen={open('rejTypes')} title="Types of rejection · 7 days" meta={rt ? <>Total <b>{fmtInt(rt.total)}</b> pcs</> : undefined}>
            {rt ? (
              <>
                {rt.stages.length ? (
                  <div className="ld-stages">
                    {rt.stages.map((st) => (
                      <span key={st.stage}><b>{st.stage}</b> {rt.total > 0 ? Math.round((st.qty / rt.total) * 100) : 0}%</span>
                    ))}
                  </div>
                ) : null}
                <RejectionTypeBars rows={rt.types} total={rt.total} />
                <div className="ld-note">From Record Rejection entries</div>
              </>
            ) : data.failedSources.includes('rejectionRecords') ? (
              <div className="ld-empty">Rejection types unavailable.</div>
            ) : (
              <div className="ld-empty">Loading rejection types…</div>
            )}
          </Panel>

          <Panel onOpen={open('lossPerDay')} title="Production loss per day" meta="Parts short of plan">
            <BarChart
              title="Production loss"
              tone="loss"
              unit="pcs"
              format={(v) => fmtInt(v)}
              days={days}
              values={series('lossParts')}
              extra={(i) => [{ label: 'Plan', value: `${fmtInt(week.days[i].plan)} pcs` }]}
              rows={[{ label: 'Pcs', values: week.days.map((d) => fmtInt(d.lossParts)) }]}
            />
          </Panel>

          <RotatingPanel
            onOpen={open('downtime')}
            views={[
              {
                title: 'Downtime by reason · 7 days',
                meta: <>Total <b>{fmtMinutes(week.totals.downtimeMinutes)}</b></>,
                body: <ReasonBars items={week.downtimeReasons} total={week.totals.downtimeMinutes} />,
              },
              {
                title: 'Downtime trend · 7 days',
                meta: 'Minutes lost to stops per day',
                body: (
                  <LineTrendChart
                    title="Downtime"
                    tone="loss"
                    unit="min"
                    format={fmtMinutes}
                    days={days}
                    values={week.days.map((d) => Math.round(d.downtimeMinutes))}
                    rows={[{ label: 'Time', values: week.days.map((d) => fmtMinutes(d.downtimeMinutes)) }]}
                  />
                ),
              },
            ]}
          />
        </div>
        <Ticker data={data} />
            </React.Fragment>,
            <RunningLinesPage key="lines" lines={data.lines} active={page === 1 && !detail} onOpenLine={(lineId) => setDetail({ kind: 'line', lineId })} />,
          ]}
        />
        {detail ? <DetailView data={data} detail={detail} days={days} dayLabel={(k) => dayLabel(k)} onClose={closeDetail} /> : null}
      </>
    );
  }

  return (
    <div className="ld">
      <style>{LIVE_DASHBOARD_CSS}</style>
      <header className="ld-header">
        <div className="ld-brand">
          <div className="ld-brand__logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h4l3-8 4 16 3-8h4" />
            </svg>
          </div>
          <div>
            <div className="ld-brand__name">ProdPulse <span>Live Production</span></div>
            <div className="ld-brand__scope">
              All lines{data ? ` · ${dayLabel(data.fromKey, { day: '2-digit', month: 'short' })} – ${dayLabel(data.todayKey, { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}
            </div>
          </div>
        </div>
        {paged ? (
          <nav className="ld-tabs" aria-label="Dashboard pages">
            {PAGES.map((label, i) => (
              <button key={label} className={i === page ? 'is-on' : ''} onClick={() => setPage(i)} aria-current={i === page ? 'page' : undefined}>
                {label}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="ld-header__right">
          {data?.lastUpdateMs ? <span className="ld-updated">Updated {clock(data.lastUpdateMs)}</span> : null}
          <span className={`ld-live ${live ? 'ld-live--on' : data?.reconnecting ? 'ld-live--off' : ''}`}>
            <i aria-hidden="true" />{live ? 'LIVE' : data?.reconnecting ? 'RECONNECTING' : 'CONNECTING'}
          </span>
          <Clock />
          <FullscreenButton />
        </div>
      </header>
      {body}
    </div>
  );
}
