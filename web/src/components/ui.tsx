import type { ReactNode } from "react";
import type { OrderStatus } from "../api.ts";
import { STATUS_META } from "../lib.tsx";

export function ShieldCheck({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2.5 4.5 6.8v8C4.5 22 9.4 27.8 16 29.5c6.6-1.7 11.5-7.5 11.5-14.7v-8Z" fill="currentColor" />
      <path d="m10.8 16.1 3.6 3.6 7-7.2" fill="none" stroke="var(--shield-check, #fff)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <a href="#/" className="logo" aria-label="Kept home">
      <span className="logo-mark">
        <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 2.5 4.5 6.8v8C4.5 22 9.4 27.8 16 29.5c6.6-1.7 11.5-7.5 11.5-14.7v-8Z" fill="var(--teal)" />
          <path d="M16 2.5v27c6.6-1.7 11.5-7.5 11.5-14.7v-8Z" fill="#000" opacity=".14" />
          <path d="m10.6 16.2 3.8 3.8 7.2-7.4" fill="none" stroke="var(--bg)" strokeWidth="2.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="logo-word">Kept</span>
    </a>
  );
}

export function PromisePill({ text, size = "md" }: { text: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`promise-pill promise-pill-${size}`}>
      <ShieldCheck size={size === "lg" ? 18 : size === "sm" ? 13 : 15} />
      <span>{text}</span>
    </span>
  );
}

export function StatusPill({ status }: { status: OrderStatus }) {
  const m = STATUS_META[status] ?? { label: status, tone: "muted" };
  return (
    <span className={`status-pill tone-${m.tone}`}>
      <span className={`status-dot ${status === "paid" ? "pulse" : ""}`} />
      {m.label}
    </span>
  );
}

export function Skeleton({ w = "100%", h = 14, r = 6, style }: { w?: number | string; h?: number | string; r?: number; style?: React.CSSProperties }) {
  return <span className="skeleton" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="error-note">
      <span className="error-note-icon">!</span>
      <div>{children}</div>
    </div>
  );
}
