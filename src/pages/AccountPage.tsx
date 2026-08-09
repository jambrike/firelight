import { Database, LogOut, PackageCheck, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { PageIntro, Panel, StatusRegion } from "../components/ui";
import { useIdentity } from "../features/identity/identity-context";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Firelight could not complete the request.";
}

function formatTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type AccountAction = "profile" | "export" | "signout" | "delete";

export function AccountPage() {
  const identity = useIdentity();
  const data = identity.data;
  const [displayName, setDisplayName] = useState(data?.profile.displayName ?? "");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [workingAction, setWorkingAction] = useState<AccountAction | null>(null);
  const exportGenerationRef = useRef(0);

  useEffect(
    () => () => {
      exportGenerationRef.current += 1;
    },
    [],
  );

  if (!data) return null;

  const updateProfile = async () => {
    setWorkingAction("profile");
    setFeedback(null);
    try {
      await identity.updateProfile(displayName);
      setFeedback("Builder profile saved.");
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setWorkingAction(null);
    }
  };

  const handleProfile = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    void updateProfile();
  };

  const exportData = async () => {
    const expectedOwnerId = data.profile.id;
    const exportGeneration = ++exportGenerationRef.current;
    const exportIsCurrent = () => exportGenerationRef.current === exportGeneration;
    setWorkingAction("export");
    setFeedback("Preparing your complete account export…");
    try {
      const accountExport = await identity.getAccountExport();
      if (!exportIsCurrent()) return;
      if (accountExport.data.profile.id !== expectedOwnerId) {
        throw new Error("Your account changed before Firelight could prepare the export.");
      }
      downloadJson(
        `firelight-account-${accountExport.exportedAt.slice(0, 10)}.json`,
        accountExport,
      );
      setFeedback("Complete account data downloaded as JSON.");
    } catch (error) {
      if (exportIsCurrent()) setFeedback(messageFrom(error));
    } finally {
      if (exportIsCurrent()) setWorkingAction(null);
    }
  };

  const signOut = async () => {
    setWorkingAction("signout");
    setFeedback(null);
    try {
      await identity.signOut();
    } catch (error) {
      setFeedback(messageFrom(error));
      setWorkingAction(null);
    }
  };

  const deleteAccount = async () => {
    if (deleteConfirmation !== "DELETE") return;
    setWorkingAction("delete");
    setFeedback(null);
    try {
      await identity.deleteAccount("DELETE");
    } catch (error) {
      setFeedback(messageFrom(error));
      setWorkingAction(null);
    }
  };

  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Builder account" title="One place for your profile, kit, and data.">
        <p>Your Supabase account is the source of truth across every signed-in device.</p>
      </PageIntro>

      <section className="three-up compact-cards">
        <Panel>
          <UserRound aria-hidden="true" />
          <h2>Profile</h2>
          <p>{data.profile.email}</p>
          <p>{data.profile.emailConfirmed ? "Email confirmed" : "Email confirmation pending"}</p>
        </Panel>
        <Panel>
          <PackageCheck aria-hidden="true" />
          <h2>Connected kit</h2>
          {data.activation ? (
            <dl>
              <div>
                <dt>Access</dt>
                <dd>
                  {data.activation.kind === "grandfathered"
                    ? "Grandfathered pilot access"
                    : "Claimed kit code"}
                </dd>
              </div>
              <div>
                <dt>Batch</dt>
                <dd>{data.activation.batch}</dd>
              </div>
              <div>
                <dt>Activation ID</dt>
                <dd><code>{data.activation.id}</code></dd>
              </div>
              <div>
                <dt>Activated</dt>
                <dd>{formatTimestamp(data.activation.claimedAt)}</dd>
              </div>
            </dl>
          ) : (
            <p>No kit activated</p>
          )}
        </Panel>
        <Panel>
          <Database aria-hidden="true" />
          <h2>Saved trail</h2>
          <p>{data.progress.length} lesson record(s) synchronized.</p>
        </Panel>
      </section>

      <Panel>
        <form className="identity-form" onSubmit={handleProfile}>
          <h2>Edit builder profile</h2>
          <label>
            Builder name
            <input
              name="displayName"
              autoComplete="name"
              minLength={1}
              maxLength={40}
              required
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.currentTarget.value);
              }}
            />
          </label>
          <button className="pixel-button" type="submit" disabled={workingAction !== null}>
            {workingAction === "profile" ? "Saving…" : "Save profile"}
          </button>
        </form>
      </Panel>

      <Panel>
        <h2>Your account data</h2>
        <p>
          Download a versioned server snapshot of your profile and auth email, safe activation,
          every saved lesson version, compile history, and browser-upload evidence. Kit codes,
          secret hashes, and raw compiled artifacts are never included.
        </p>
        <div className="button-row">
          <button
            className="pixel-button pixel-button--secondary"
            type="button"
            disabled={workingAction !== null}
            onClick={() => {
              void exportData();
            }}
          >
            {workingAction === "export" ? "Preparing…" : "Export complete JSON"}
          </button>
          <button
            className="pixel-button pixel-button--secondary"
            type="button"
            disabled={workingAction !== null}
            onClick={() => {
              void signOut();
            }}
          >
            <LogOut aria-hidden="true" /> Sign out
          </button>
        </div>
      </Panel>

      <Panel className="danger-panel">
        <h2>Permanently delete account</h2>
        <p>
          This is an irreversible hard deletion. It permanently removes:
        </p>
        <ul>
          <li>Your sign-in identity and builder profile.</li>
          <li>All lesson progress, completion records, and saved code snapshots.</li>
          <li>All compile diagnostics and browser-upload evidence linked to your account.</li>
          <li>Your kit activation; a claimed kit code is revoked and cannot be reused.</li>
        </ul>
        <p>
          For security, sign out and sign back in immediately before deleting. A refreshed token
          does not count as a fresh sign-in, and the server will reject an older session.
        </p>
        <label className="identity-form">
          Type DELETE exactly to confirm
          <input
            value={deleteConfirmation}
            onChange={(event) => {
              setDeleteConfirmation(event.currentTarget.value);
            }}
            autoComplete="off"
          />
        </label>
        <button
          className="pixel-button danger-button"
          type="button"
          disabled={workingAction !== null || deleteConfirmation !== "DELETE"}
          onClick={() => {
            void deleteAccount();
          }}
        >
          {workingAction === "delete" ? "Deleting permanently…" : "Permanently delete my account"}
        </button>
      </Panel>

      {feedback ? <StatusRegion>{feedback}</StatusRegion> : null}
    </div>
  );
}
