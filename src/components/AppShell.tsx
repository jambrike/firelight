import { Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { getRouteMetadata } from "../app/route-metadata";
import { Brand } from "./Brand";

const navigation = [
  { to: "/learn", label: "Learn" },
  { to: "/kit", label: "Kit" },
  { to: "/camp", label: "Camp" },
  { to: "/account", label: "Account" },
] as const;

export function AppShell({ children }: { readonly children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [routeAnnouncement, setRouteAnnouncement] = useState("");
  const [location] = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const previousLocationRef = useRef(location);

  const isActive = (path: string) =>
    path === "/learn" ? location.startsWith("/learn") : location === path;

  useEffect(() => {
    const metadata = getRouteMetadata(location);
    document.title = `${metadata.title} — Firelight`;

    if (previousLocationRef.current !== location) {
      previousLocationRef.current = location;
      setRouteAnnouncement(`${metadata.announcement} loaded.`);
      mainRef.current?.focus();
    }
  }, [location]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <Brand />
          <button
            className="nav-toggle"
            type="button"
            aria-controls="primary-navigation"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open);
            }}
          >
            {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            <span className="sr-only">{menuOpen ? "Close menu" : "Open menu"}</span>
          </button>
          <nav
            className="site-nav"
            id="primary-navigation"
            aria-label="Primary navigation"
            data-open={menuOpen}
          >
            {navigation.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={isActive(item.to) ? "active" : undefined}
                aria-current={isActive(item.to) ? "page" : undefined}
                onClick={() => {
                  setMenuOpen(false);
                }}
              >
                {item.label}
              </Link>
            ))}
            <Link
              className="pixel-button pixel-button--small"
              to="/auth"
              onClick={() => {
                setMenuOpen(false);
              }}
            >
              Light a kit
            </Link>
          </nav>
        </div>
      </header>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {routeAnnouncement}
      </p>
      <main id="main-content" ref={mainRef} tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div>
          <Brand />
          <p>Real circuits. Real code. One small spark at a time.</p>
        </div>
        <nav aria-label="Footer navigation">
          <Link to="/kit">Kit and safety</Link>
          <Link to="/learn">Build path</Link>
          <Link to="/admin">Pilot support</Link>
        </nav>
      </footer>
    </div>
  );
}
