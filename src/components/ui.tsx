import type { ReactNode } from "react";
import { Link } from "wouter";
import type { HardwareWorkflowPhase } from "../features/hardware/contracts";

export function PageIntro({
  eyebrow,
  title,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <header className="page-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <div className="page-intro__copy">{children}</div>
    </header>
  );
}

export function Panel({
  children,
  className = "",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <section className={`panel ${className}`.trim()}>{children}</section>;
}

export function PixelLink({
  to,
  children,
  secondary = false,
}: {
  readonly to: string;
  readonly children: ReactNode;
  readonly secondary?: boolean;
}) {
  return (
    <Link
      className={`pixel-button${secondary ? " pixel-button--secondary" : ""}`}
      to={to}
    >
      {children}
    </Link>
  );
}

export function ProgressBar({
  label,
  value,
  max = 100,
}: {
  readonly label: string;
  readonly value: number;
  readonly max?: number;
}) {
  return (
    <div className="progress-stack">
      <div className="progress-stack__label">
        <span>{label}</span>
        <span>{Math.round((value / max) * 100)}%</span>
      </div>
      <progress aria-label={label} value={value} max={max} />
    </div>
  );
}

export function FeaturePlaceholder({
  label,
  title,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <aside className="feature-placeholder" aria-label={label}>
      <span className="status-chip">Foundation ready</span>
      <h2>{title}</h2>
      <div>{children}</div>
    </aside>
  );
}

const phaseLabels: Record<HardwareWorkflowPhase, string> = {
  idle: "Not connected",
  compiling: "Compiling",
  compiled: "Ready to connect",
  connecting: "Connecting",
  connected: "Board connected",
  uploading: "Sending sketch",
  success: "Upload complete",
  error: "Needs attention",
};

export function HardwareStatus({ phase = "idle" }: { readonly phase?: HardwareWorkflowPhase }) {
  return (
    <div className="hardware-status" data-phase={phase} role="status">
      <span className="hardware-status__light" aria-hidden="true" />
      <span>
        <strong>Arduino Nano</strong>
        <small>{phaseLabels[phase]}</small>
      </span>
    </div>
  );
}

export function StatusRegion({ children }: { readonly children: ReactNode }) {
  return (
    <p className="status-region" role="status" aria-live="polite" aria-atomic="true">
      {children}
    </p>
  );
}
