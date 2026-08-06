import type { ReactNode } from "react";
import { PixelLink } from "../../components/ui";
import { useIdentity } from "./identity-context";

export function SessionBoundary({
  children,
  admin = false,
}: {
  readonly children: ReactNode;
  readonly admin?: boolean;
}) {
  const identity = useIdentity();

  if (identity.status === "loading") {
    return (
      <div className="page-section narrow-page page-stack" role="status">
        <p className="eyebrow">Checking the camp</p>
        <h1>Loading your builder account…</h1>
      </div>
    );
  }

  if (identity.status !== "authenticated" || !identity.data) {
    return (
      <div className="page-section narrow-page page-stack">
        <p className="eyebrow">Account required</p>
        <h1>Sign in to open this part of camp.</h1>
        {identity.error ? <p className="form-error">{identity.error}</p> : null}
        <PixelLink to="/auth">Open account entry</PixelLink>
      </div>
    );
  }

  if (admin && identity.data.profile.role !== "admin") {
    return (
      <div className="page-section narrow-page page-stack">
        <p className="eyebrow">Pilot support</p>
        <h1>This trail is for Firelight support staff.</h1>
        <PixelLink to="/camp">Return to camp</PixelLink>
      </div>
    );
  }

  return children;
}
