import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz, type ColDef, type GetRowIdParams, type ICellRendererParams, type RowClassParams } from "ag-grid-community";
import { api, type AgentEvent, type OrderRow, type OrderStatus, type Stats } from "../api.ts";
import { fmtDateTime, fmtTime, go, money, STATUS_META, timeAgo, usePoll, useServerNow } from "../lib.tsx";
import { PromisePill, Skeleton, StatusPill } from "../components/ui.tsx";

const gridTheme = themeQuartz.withParams({
  accentColor: "#0E5A57",
  backgroundColor: "#FFFDF9",
  foregroundColor: "#1D2422",
  borderColor: "#E9E1D3",
  chromeBackgroundColor: "#F5F0E7",
  headerBackgroundColor: "#F5F0E7",
  headerTextColor: "#5E655F",
  headerFontWeight: 600,
  headerFontSize: 12,
  fontFamily: { googleFont: "Inter" },
  fontSize: 13,
  rowHeight: 60,
  headerHeight: 44,
  spacing: 7,
  wrapperBorderRadius: 16,
  wrapperBorder: { color: "#E9E1D3" },
  rowBorder: { color: "#F0EADF" },
  columnBorder: false,
  oddRowBackgroundColor: "#FFFDF9",
  rowHoverColor: "#F3F7F5",
  selectedRowBackgroundColor: "#E7F1EF",
  valueChangeValueHighlightBackgroundColor: "#CDEBD9",
});

type Row = OrderRow & { evidence: string | null; evidence_kind: AgentEvent["kind"] | null };

type Bucket = "all" | OrderStatus;
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "all", label: "All orders" },
  { key: "paid", label: "Watching" },
  { key: "kept", label: "Kept" },
  { key: "held", label: "Held" },
  { key: "breached", label: "Refunding" },
  { key: "refunded", label: "Refunded" },
  { key: "declined", label: "Declined" },
  { key: "failed", label: "Needs a human" },
  { key: "created", label: "Unpaid" },
];

const EVIDENCE_KINDS: AgentEvent["kind"][] = ["evidence", "kept", "breach", "refund", "error", "watching", "assessment", "hold"];

function StatusCell(p: ICellRendererParams<Row>) {
  return p.data && !p.node.rowPinned ? <StatusPill status={p.data.status} /> : null;
}
function deadlineText(d: Row) {
  if (d.deadline_at) return `Due ${fmtDateTime(d.deadline_at)}`;
  if (d.event_date) {
    const [y, m, day] = d.event_date.split("-").map(Number);
    const short = new Date(Date.UTC(y, m - 1, day, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
    return `Tour ${short}${d.event_location ? ` · ${d.event_location.name}` : ""}`;
  }
  return "";
}
function BadgeCell(p: ICellRendererParams<Row>) {
  const d = p.data;
  if (!d || p.node.rowPinned) return null;
  const b = d.promise_snapshot?.badge;
  if (!b) return <span className="muted">No promise</span>;
  return (
    <span className="two-line">
      <PromisePill text={b} size="sm" />
      <span className="cell-sub">{deadlineText(d)}</span>
    </span>
  );
}
function OrderCell(p: ICellRendererParams<Row>) {
  const d = p.data;
  if (!d) return null;
  if (p.node.rowPinned) return <span className="cell-total">{d.product_name}</span>;
  const name = d.buyer_name ?? "Awaiting buyer";
  const initials = d.buyer_name ? d.buyer_name.split(/\s+/).map((s) => s[0]).slice(0, 2).join("") : "·";
  return (
    <span className="buyer-cell">
      <span className="avatar">{initials}</span>
      <span>
        <span className="cell-strong">{d.product_name}</span>
        <span className="cell-sub">
          {name} · {fmtDateTime(d.created_at).replace(/^\w+, /, "")}
        </span>
      </span>
    </span>
  );
}
function EvidenceCell(p: ICellRendererParams<Row>) {
  if (p.node.rowPinned) return null;
  if (!p.data?.evidence) return <span className="muted">Waiting for first evidence…</span>;
  return <span className={`evidence-cell ev-${p.data.evidence_kind}`} title={p.data.evidence}>{p.data.evidence}</span>;
}
function PayoutCell(p: ICellRendererParams<Row>) {
  if (p.node.rowPinned) return <span className="cell-total">{money(p.value)}</span>;
  if (p.value == null || p.value === 0) return <span className="muted">—</span>;
  return <span className="payout-cell">{money(p.value)}</span>;
}
function RefundCell(p: ICellRendererParams<Row>) {
  if (p.node.rowPinned) return null;
  return p.value ? <code className="refund-code">{p.value}</code> : <span className="muted">—</span>;
}

export function Ledger() {
  const orders = usePoll((signal) => api<OrderRow[]>("/api/orders", { signal }), 3000);
  const events = usePoll((signal) => api<AgentEvent[]>("/api/events", { signal }), 3000);
  const stats = usePoll((signal) => api<Stats>("/api/stats", { signal }), 3000);
  const [quick, setQuick] = useState("");
  const [bucket, setBucket] = useState<Bucket>("all");
  const gridRef = useRef<AgGridReact<Row>>(null);

  const rows: Row[] = useMemo(() => {
    const latest = new Map<string, AgentEvent>();
    // /api/events is newest-first
    for (const e of events.data ?? []) if (e.order_id && (EVIDENCE_KINDS.includes(e.kind) || (e.kind === "info" && e.message.startsWith("Merchant "))) && !latest.has(e.order_id)) latest.set(e.order_id, e);
    return (orders.data ?? []).map((o) => {
      const ev = latest.get(o.id);
      return { ...o, evidence: ev?.message ?? null, evidence_kind: ev?.kind ?? null };
    });
  }, [orders.data, events.data]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const r of rows) {
      c[r.status] = (c[r.status] ?? 0) + 1;
      if (r.status !== "created") c.all++;
    }
    return c;
  }, [rows]);

  const bucketRef = useRef(bucket);
  bucketRef.current = bucket;
  useEffect(() => {
    gridRef.current?.api?.onFilterChanged();
  }, [bucket]);

  const isExternalFilterPresent = useCallback(() => true, []);
  const doesExternalFilterPass = useCallback((node: { data?: Row }) => {
    const b = bucketRef.current;
    const s = node.data?.status;
    return b === "all" ? s !== "created" : s === b;
  }, []);

  const visible = rows.filter((r) => (bucket === "all" ? r.status !== "created" : r.status === bucket));
  const pinnedBottom = useMemo(
    () => [{ id: "__total", product_name: `Total · ${visible.length} order${visible.length === 1 ? "" : "s"}`, amount_total: visible.reduce((s, r) => s + r.amount_total, 0), payout_amount: visible.reduce((s, r) => s + (r.payout_amount ?? 0), 0) }],
    [visible.length, visible.map((r) => `${r.amount_total}:${r.payout_amount}`).join()], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      {
        headerName: "Order",
        colId: "order",
        field: "product_name",
        width: 196,
        cellRenderer: OrderCell,
        filter: "agTextColumnFilter",
        getQuickFilterText: (p) => `${p.data?.product_name ?? ""} ${p.data?.buyer_name ?? ""} ${p.data?.buyer_email ?? ""} ${p.data?.id ?? ""}`,
      },
      {
        headerName: "Placed",
        field: "created_at",
        hide: true,
        sort: "desc",
        filter: "agDateColumnFilter",
        filterValueGetter: (p) => (p.data?.created_at ? new Date(p.data.created_at) : null),
      },
      {
        headerName: "Promise · deadline",
        colId: "badge",
        valueGetter: (p) => p.data?.promise_snapshot?.badge ?? "",
        cellRenderer: BadgeCell,
        width: 212,
        filter: "agTextColumnFilter",
      },
      {
        headerName: "Status",
        field: "status",
        width: 118,
        cellRenderer: StatusCell,
        filter: "agTextColumnFilter",
        getQuickFilterText: (p) => STATUS_META[p.data?.status as OrderStatus]?.label ?? "",
        comparator: (a: OrderStatus, b: OrderStatus) => ORDER.indexOf(a) - ORDER.indexOf(b),
      },
      { headerName: "Latest evidence", field: "evidence", flex: 1, minWidth: 160, cellRenderer: EvidenceCell, filter: "agTextColumnFilter", tooltipField: "evidence" },
      { headerName: "Payout", field: "payout_amount", width: 88, type: "rightAligned", cellRenderer: PayoutCell, filter: "agNumberColumnFilter" },
      { headerName: "PayPal refund", field: "paypal_refund_id", width: 128, cellRenderer: RefundCell, filter: "agTextColumnFilter" },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<Row>>(() => ({ sortable: true, resizable: true, enableCellChangeFlash: true, suppressHeaderMenuButton: false }), []);
  const getRowId = useCallback((p: GetRowIdParams<Row>) => p.data.id, []);
  const getRowClass = useCallback((p: RowClassParams<Row>) => (p.data?.status === "refunded" ? "row-refunded" : p.data?.status === "breached" || p.data?.status === "held" ? "row-breached" : undefined), []);

  return (
    <div className="page ledger">
      <header className="page-head ledger-head">
        <div>
          <div className="eyebrow">Merchant · Harbor &amp; Clay</div>
          <h1 className="display-sm">Ledger</h1>
          <p className="lede">Every order, the promise it carries, the evidence Kept found, and what was paid out. Live.</p>
        </div>
      </header>

      <StatsStrip stats={stats.data} loading={stats.loading && !stats.data} />
      <ReviewCallout rows={rows} />

      <div className="ledger-grid">
        <aside className="card status-rail">
          <div className="rail-label">Status</div>
          {BUCKETS.map((b) => (
            <button key={b.key} className={`rail-item ${bucket === b.key ? "on" : ""}`} onClick={() => setBucket(b.key)}>
              {b.key === "all" ? <span className="rail-dot tone-ink" /> : <span className={`rail-dot tone-${STATUS_META[b.key].tone}`} />}
              <span className="rail-name">{b.label}</span>
              <span className="rail-count">{counts[b.key] ?? 0}</span>
            </button>
          ))}
          <div className="rail-note">Click a status to slice the grid. Sort, filter and resize any column.</div>
        </aside>

        <section className="grid-col">
          <div className="grid-toolbar">
            <div className="search">
              <span aria-hidden="true">⌕</span>
              <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Search buyers, products, promises, refund ids…" />
              {quick && (
                <button className="search-clear" onClick={() => setQuick("")} aria-label="Clear">
                  ×
                </button>
              )}
            </div>
            <span className="muted small">
              <span className="live-dot small" /> Live · refreshes every 3s
            </span>
            <button className="btn btn-sm" onClick={() => gridRef.current?.api?.exportDataAsCsv({ fileName: "kept-ledger.csv" })}>
              Export CSV
            </button>
          </div>
          <div className="grid-wrap">
            <AgGridReact<Row>
              ref={gridRef}
              theme={gridTheme}
              rowData={rows}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              getRowId={getRowId}
              getRowClass={getRowClass}
              quickFilterText={quick}
              isExternalFilterPresent={isExternalFilterPresent}
              doesExternalFilterPass={doesExternalFilterPass}
              pinnedBottomRowData={pinnedBottom as unknown as Row[]}
              onRowClicked={(e) => e.data && !e.node.rowPinned && e.data.id !== "__total" && go(`/order/${e.data.id}`)}
              animateRows
              cellFlashDuration={900}
              tooltipShowDelay={400}
              loading={orders.loading && !orders.data}
              overlayNoRowsTemplate='<div class="grid-empty"><div class="grid-empty-title">No orders here yet</div><div>Buy something in the Shop and it shows up live.</div></div>'
              rowClass="grid-row"
            />
          </div>
        </section>

        <ActivityFeed events={events.data} loading={events.loading && !events.data} />
      </div>
    </div>
  );
}

const ORDER: OrderStatus[] = ["held", "breached", "failed", "paid", "refunded", "declined", "kept", "created"];

function StatsStrip({ stats, loading }: { stats: Stats | null; loading: boolean }) {
  const pct = stats && stats.budget > 0 ? Math.min(100, (stats.budget_used / stats.budget) * 100) : 0;
  const tiles: { label: string; value: string; tone?: string; foot?: string }[] = stats
    ? [
        { label: "Revenue", value: money(stats.revenue), foot: `${stats.orders} paid orders` },
        { label: "Watching", value: String(stats.watching), tone: "teal", foot: "promises live right now" },
        { label: "Kept", value: String(stats.kept), tone: "green", foot: "no payout needed" },
        { label: "Refunded", value: String(stats.refunded), tone: "green", foot: "automatically, no claims" },
        { label: "Paid out", value: money(stats.paid_out), foot: stats.revenue > 0 ? `${((stats.paid_out / stats.revenue) * 100).toFixed(1)}% of revenue` : "—" },
      ]
    : [];
  return (
    <section className="stats">
      {loading
        ? [0, 1, 2, 3, 4, 5].map((i) => (
            <div className="stat" key={i}>
              <Skeleton w="50%" h={11} />
              <Skeleton w="70%" h={28} style={{ marginTop: 10 }} />
            </div>
          ))
        : tiles.map((t) => (
            <div className="stat" key={t.label}>
              <div className="stat-label">{t.label}</div>
              <div className={`stat-value ${t.tone ? `tone-${t.tone}` : ""}`}>{t.value}</div>
              {t.foot && <div className="stat-foot">{t.foot}</div>}
            </div>
          ))}
      {stats && (
        <div className="stat stat-budget">
          <div className="stat-label">Guarantee budget · this month</div>
          <div className="stat-value">
            {money(stats.budget_used)} <span className="stat-of">of {money(stats.budget)}</span>
          </div>
          <div className="meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${pct}%` }} className={pct > 80 ? "hot" : ""} />
          </div>
          <div className="stat-foot">Hard cap the agent can never exceed.</div>
        </div>
      )}
    </section>
  );
}

const FEED_ICON: Record<AgentEvent["kind"], string> = {
  compiled: "✎",
  watching: "◉",
  evidence: "⌕",
  kept: "✓",
  breach: "▲",
  refund: "$",
  error: "✕",
  info: "·",
  assessment: "✦",
  hold: "‖",
};

function ReviewCallout({ rows }: { rows: Row[] }) {
  const held = rows.filter((r) => r.status === "held");
  if (!held.length) return null;
  // rows are newest-first; the oldest held order has waited longest
  const first = held[held.length - 1];
  return (
    <a className="review-callout" href={`#/order/${first.id}`}>
      <span className="review-callout-icon" aria-hidden="true">‖</span>
      <span className="review-callout-text">
        <strong>
          {held.length === 1 ? "1 payout needs your review" : `${held.length} payouts need your review`}
        </strong>
        <span>
          Claude paused {held.length === 1 ? "it" : "them"} because the carrier scans point at the buyer's side ({first.product_name}, {first.buyer_name ?? "buyer"}). Claude can pause a payout, never create one.
        </span>
      </span>
      <span className="review-callout-go">Review →</span>
    </a>
  );
}

function ActivityFeed({ events, loading }: { events: AgentEvent[] | null; loading: boolean }) {
  const now = useServerNow(5000);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!events) return;
    if (!seen.current) {
      seen.current = new Set(events.map((e) => e.id));
      return;
    }
    const add = events.filter((e) => !seen.current!.has(e.id)).map((e) => e.id);
    if (!add.length) return;
    add.forEach((id) => seen.current!.add(id));
    setFresh(new Set(add));
  }, [events]);

  return (
    <aside className="feed">
      <div className="feed-head">
        <span className="feed-dots">
          <i />
          <i />
          <i />
        </span>
        <span>kept-agent — activity</span>
        <span className="feed-live">
          <span className="live-dot small" /> live
        </span>
      </div>
      <ol className="feed-list">
        {loading &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="feed-item">
              <Skeleton w="85%" h={11} style={{ opacity: 0.25 }} />
            </li>
          ))}
        {events?.length === 0 && <li className="feed-empty">$ waiting for the first promise…</li>}
        {events?.map((e) => (
          <li key={e.id} className={`feed-item k-${e.kind} ${fresh.has(e.id) ? "fresh" : ""}`}>
            <span className="feed-icon">{FEED_ICON[e.kind]}</span>
            <div className="feed-body">
              <div className="feed-meta">
                <span className="feed-kind">{e.kind}</span>
                {e.order_id && (
                  <a href={`#/order/${e.order_id}`} className="feed-order">
                    {e.order_id}
                  </a>
                )}
                <span className="feed-at" title={fmtDateTime(e.at)}>
                  {fmtTime(e.at)} · {timeAgo(e.at, now.getTime())}
                </span>
              </div>
              <div className="feed-msg">{e.message}</div>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
