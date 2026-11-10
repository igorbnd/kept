import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import "./styles.css";
import { ClockProvider, ToastProvider, useClock, useHashRoute } from "./lib.tsx";
import { Logo } from "./components/ui.tsx";
import { DemoDrawer } from "./components/DemoDrawer.tsx";
import { Shop } from "./pages/Shop.tsx";
import { OrderPage } from "./pages/OrderPage.tsx";
import { Studio } from "./pages/Studio.tsx";
import { Ledger } from "./pages/Ledger.tsx";

ModuleRegistry.registerModules([AllCommunityModule]);

function Nav({ path, demoOpen, onToggleDemo }: { path: string; demoOpen: boolean; onToggleDemo: () => void }) {
  const { config } = useClock();
  const simulated = (config?.clock_offset_ms ?? 0) !== 0;
  const link = (href: string, label: string, active: boolean) => (
    <a href={href} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <header className={`nav ${path.startsWith("/ledger") ? "nav-wide" : ""}`}>
      <div className="nav-inner">
        <div className="nav-left">
          <Logo />
          <span className="nav-tagline">Promises that keep themselves.</span>
        </div>
        <nav className="nav-links">
          {link("#/", "Shop", path === "/" || path.startsWith("/order"))}
          {link("#/studio", "Promise Studio", path.startsWith("/studio"))}
          {link("#/ledger", "Ledger", path.startsWith("/ledger"))}
        </nav>
        <button className={`demo-toggle ${demoOpen ? "on" : ""}`} onClick={onToggleDemo} aria-expanded={demoOpen}>
          <span className={`demo-toggle-dot ${simulated ? "sim" : ""}`} />
          Demo controls
        </button>
      </div>
    </header>
  );
}

function App() {
  const path = useHashRoute();
  const [demoOpen, setDemoOpen] = useState(() => {
    try {
      return localStorage.getItem("kept:demo") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("kept:demo", demoOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [demoOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDemoOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let page;
  const orderMatch = path.match(/^\/order\/([^/?]+)/);
  if (orderMatch) page = <OrderPage id={decodeURIComponent(orderMatch[1])} />;
  else if (path.startsWith("/studio")) page = <Studio />;
  else if (path.startsWith("/ledger")) page = <Ledger />;
  else page = <Shop />;

  return (
    <>
      <Nav path={path} demoOpen={demoOpen} onToggleDemo={() => setDemoOpen((o) => !o)} />
      <main className={`main ${path.startsWith("/ledger") ? "main-wide" : ""}`} key={orderMatch ? "order" : path}>
        {page}
      </main>
      <footer className="footer">
        <span>
          <strong>Kept</strong> · The Kept agent (powered by Claude) writes the rule. Code enforces it. PayPal pays it.
        </span>
        <span className="footer-muted">Payouts are capped at what was paid and the shop's monthly guarantee budget.</span>
        <span className="footer-muted">Harbor &amp; Clay is a fictional demo shop. All payments are PayPal sandbox; no real money moves.</span>
      </footer>
      <DemoDrawer open={demoOpen} onClose={() => setDemoOpen(false)} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ClockProvider>
        <App />
      </ClockProvider>
    </ToastProvider>
  </StrictMode>,
);
