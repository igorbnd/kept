import { useEffect, useState } from "react";
import { api, post, type ProductWithPromise, type PromiseRecord } from "../api.ts";
import { announceWorldChanged, fmtDateTime, SOURCE_LABEL, useClock, usePoll, useToast } from "../lib.tsx";
import { Empty, ErrorNote, PromisePill, ShieldCheck, Skeleton, Spinner } from "../components/ui.tsx";
import { RuleRow } from "./OrderPage.tsx";

const EXAMPLES = ["Arrives by Friday or shipping's on us", "Ships within 24 hours or $5 back", "Rain on tour day = 50% back", "You'll love it or your money back"];
const THINKING = ["Finding the condition…", "Choosing a source of evidence…", "Working out the payout…", "Checking it can be verified without a human…"];

export function Studio() {
  const toast = useToast();
  const { config } = useClock();
  const products = usePoll((signal) => api<ProductWithPromise[]>("/api/products", { signal }), 0);
  const promises = usePoll((signal) => api<PromiseRecord[]>("/api/promises", { signal }), 0);
  const [productId, setProductId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [thinkIdx, setThinkIdx] = useState(0);
  const [result, setResult] = useState<PromiseRecord | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    // Also re-pick after a demo reset, which replaces every product id.
    if (products.data?.length && !products.data.some((p) => p.id === productId)) setProductId(products.data[0].id);
  }, [products.data, productId]);

  useEffect(() => {
    if (!compiling) return;
    setThinkIdx(0);
    const id = setInterval(() => setThinkIdx((i) => (i + 1) % THINKING.length), 1400);
    return () => clearInterval(id);
  }, [compiling]);

  const product = products.data?.find((p) => p.id === productId) ?? null;

  async function compile(t = text) {
    if (!productId || t.trim().length < 3) return;
    setCompiling(true);
    setCompileError(null);
    setResult(null);
    try {
      const rec = await post<PromiseRecord>("/api/promises/compile", { product_id: productId, text: t.trim() });
      setResult(rec);
      promises.reload();
    } catch (e) {
      setCompileError((e as Error).message);
      toast(`Compile failed: ${(e as Error).message}`, "error");
    } finally {
      setCompiling(false);
    }
  }

  async function activate() {
    if (!result) return;
    setActivating(true);
    try {
      const rec = await post<PromiseRecord>(`/api/promises/${result.id}/activate`);
      setResult(rec);
      toast(`Live on ${product?.name}: “${rec.compiled.badge}”`, "success");
      products.reload();
      promises.reload();
      announceWorldChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setActivating(false);
    }
  }

  const active = (promises.data ?? []).filter((p) => p.status === "active");
  const budget = config?.merchant.monthly_guarantee_budget ?? 500;

  return (
    <div className="page studio">
      <header className="page-head">
        <div>
          <div className="eyebrow">Merchant · Harbor &amp; Clay</div>
          <h1 className="display-sm">Promise Studio</h1>
          <p className="lede">Write the guarantee the way you'd say it at the counter. Claude turns it into a rule you can read, check and approve. Code enforces it from there.</p>
        </div>
      </header>

      <div className="studio-grid">
        <section className="card studio-editor">
          <div className="step-label">
            <span>1</span> Choose a product
          </div>
          <div className="product-picker">
            {products.loading && !products.data
              ? [0, 1, 2].map((i) => <Skeleton key={i} h={64} r={12} />)
              : products.data?.map((p) => (
                  <button key={p.id} className={`pick ${p.id === productId ? "on" : ""}`} onClick={() => setProductId(p.id)}>
                    <span className="pick-emoji">{p.image}</span>
                    <span className="pick-text">
                      <strong>{p.name}</strong>
                      <span>{p.kind === "experience" ? "Experience" : "Ships"}</span>
                    </span>
                  </button>
                ))}
          </div>
          {products.error && <ErrorNote>{products.error}</ErrorNote>}

          <div className="step-label">
            <span>2</span> Write your promise
          </div>
          <textarea
            className="promise-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Order by Tuesday and it arrives by Friday, or your shipping's on us."
            rows={4}
            maxLength={500}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) compile();
            }}
          />
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="chip" onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div className="editor-foot">
            <span className="muted small">⌘↵ to compile</span>
            <button className="btn btn-primary btn-lg" disabled={compiling || !productId || text.trim().length < 3} onClick={() => compile()}>
              {compiling ? (
                <>
                  <Spinner size={14} /> Compiling…
                </>
              ) : (
                "Compile promise"
              )}
            </button>
          </div>
        </section>

        <section className="studio-result">
          {compiling ? (
            <div className="card contract thinking">
              <div className="thinking-head">
                <span className="claude-orb" />
                <div>
                  <strong>Claude is reading your promise…</strong>
                  <div className="muted small thinking-step" key={thinkIdx}>
                    {THINKING[thinkIdx]}
                  </div>
                </div>
              </div>
              <Skeleton w="55%" h={30} r={99} style={{ marginTop: 22 }} />
              <Skeleton w="95%" style={{ marginTop: 18 }} />
              <Skeleton w="80%" style={{ marginTop: 8 }} />
              <Skeleton w="70%" h={34} r={10} style={{ marginTop: 20 }} />
            </div>
          ) : result ? (
            <ContractCard rec={result} productName={product?.name ?? ""} budget={budget} activating={activating} onActivate={activate} onUseRewrite={(t) => { setText(t); compile(t); }} />
          ) : compileError ? (
            <div className="card contract">
              <ErrorNote>
                <strong>Couldn't compile that.</strong> {compileError}
              </ErrorNote>
            </div>
          ) : (
            <div className="card contract placeholder">
              <Empty icon={<ShieldCheck size={30} />} title="Your contract card appears here">
                You'll see exactly how Kept will enforce the promise: the rule, the evidence it checks, and anything Claude had to assume.
              </Empty>
            </div>
          )}
        </section>
      </div>

      <section className="active-promises">
        <h2 className="serif section-title">Live promises</h2>
        {promises.loading && !promises.data ? (
          <div className="active-list">
            {[0, 1].map((i) => (
              <div className="card" key={i}>
                <Skeleton w="50%" />
                <Skeleton w="80%" h={26} r={99} style={{ marginTop: 12 }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="active-list">
            {(products.data ?? []).map((p) => {
              const live = active.find((a) => a.product_id === p.id);
              return (
                <div className={`card active-item ${live ? "" : "is-empty"}`} key={p.id}>
                  <div className="active-item-head">
                    <span className="pick-emoji">{p.image}</span>
                    <strong>{p.name}</strong>
                    {live && <span className="live-tag"><span className="live-dot small" /> Live</span>}
                  </div>
                  {live ? (
                    <>
                      <PromisePill text={live.compiled.badge} size="sm" />
                      <p className="muted small active-src">“{live.source_text}”</p>
                      <div className="muted xsmall">Live since {fmtDateTime(live.created_at)}</div>
                    </>
                  ) : (
                    <p className="muted small">No promise yet.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function ContractCard({
  rec,
  productName,
  budget,
  activating,
  onActivate,
  onUseRewrite,
}: {
  rec: PromiseRecord;
  productName: string;
  budget: number;
  activating: boolean;
  onActivate: () => void;
  onUseRewrite: (t: string) => void;
}) {
  const c = rec.compiled;
  if (!c.checkable || !c.rule) {
    return (
      <div className="card contract contract-reject">
        <div className="contract-top">
          <span className="reject-icon">!</span>
          <div>
            <div className="status-eyebrow tone-red">Can't be checked automatically</div>
            <h3 className="serif">“{rec.source_text}”</h3>
          </div>
        </div>
        <p>{c.plain_english}</p>
        {c.suggested_rewrite && (
          <div className="rewrite">
            <div className="rewrite-label">A promise Kept can actually keep</div>
            <p className="rewrite-text">“{c.suggested_rewrite}”</p>
            <button className="btn btn-primary" onClick={() => onUseRewrite(c.suggested_rewrite!)}>
              Use this instead
            </button>
          </div>
        )}
        <p className="muted xsmall">Kept refuses subjective promises on purpose: nobody, human or AI, should be deciding whether you “loved it”.</p>
      </div>
    );
  }
  const isLive = rec.status === "active";
  return (
    <div className={`card contract ${isLive ? "contract-live" : ""}`}>
      <div className="contract-head">
        <div className="eyebrow">Contract for {productName}</div>
        <span className={`contract-state ${isLive ? "live" : ""}`}>{isLive ? "● Live" : "Draft · needs your approval"}</span>
      </div>
      <div className="badge-preview">
        <span className="muted xsmall">Buyers will see</span>
        <PromisePill text={c.badge} size="lg" />
      </div>
      <p className="contract-plain">{c.plain_english}</p>
      <div className="contract-section">
        <div className="contract-label">Rule</div>
        <RuleRow rule={c.rule} />
        <div className="muted xsmall">Payout capped at the amount captured and your {`$${budget}`} monthly guarantee budget.</div>
      </div>
      <div className="contract-cols">
        <div className="contract-section">
          <div className="contract-label">Evidence</div>
          <div className="source-chip">{c.data_source === "carrier_tracking" ? "📦" : c.data_source === "open_meteo_weather" ? "🌦" : "—"} {SOURCE_LABEL[c.data_source]}</div>
        </div>
        {c.needs_from_buyer.length > 0 && (
          <div className="contract-section">
            <div className="contract-label">Asked at checkout</div>
            <div className="muted small">{c.needs_from_buyer.map((n) => (n === "event_date" ? "Event date" : "Event location")).join(" · ")}</div>
          </div>
        )}
      </div>
      {c.assumptions.length > 0 && (
        <div className="contract-section">
          <div className="contract-label">Assumptions Claude made</div>
          <ul className="list-check">
            {c.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {c.questions.length > 0 && (
        <div className="contract-section">
          <div className="contract-label">Worth a second look</div>
          <ul className="list-warn">
            {c.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="contract-foot">
        <span className="muted xsmall">The AI wrote this rule. Code enforces it. You approve it.</span>
        {isLive ? (
          <a className="btn" href="#/">
            See it in the shop →
          </a>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={onActivate} disabled={activating}>
            {activating ? <Spinner size={14} /> : <ShieldCheck size={16} />} Approve &amp; go live
          </button>
        )}
      </div>
    </div>
  );
}
