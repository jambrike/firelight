import { Database, LogOut, PackageCheck, UserRound } from "lucide-react";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { PageIntro, Panel, StatusRegion } from "../components/ui";
import { useIdentity } from "../features/identity/identity-context";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Firelight could not complete the request.";
}

export function AccountPage() {
  const identity = useIdentity();
  const data = identity.data;
  const [displayName, setDisplayName] = useState(data?.profile.displayName ?? "");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  if (!data) return null;

  const updateProfile = async () => {
    setWorking(true);
    setFeedback(null);
    try {
      await identity.updateProfile(displayName);
      setFeedback("Builder profile saved.");
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setWorking(false);
    }
  };

  const handleProfile = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    void updateProfile();
  };

  const exportData = () => {
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      profile: data.profile,
      activation: data.activation,
      progress: data.progress,
      achievements: data.achievements,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "firelight-account-data.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setFeedback("Account data export prepared.");
  };

  const signOut = async () => {
    setWorking(true);
    try {
      await identity.signOut();
    } catch (error) {
      setFeedback(messageFrom(error));
      setWorking(false);
    }
  };

  const deleteAccount = async () => {
    if (deleteConfirmation !== "DELETE") return;
    setWorking(true);
    setFeedback(null);
    try {
      await identity.deleteAccount();
    } catch (error) {
      setFeedback(messageFrom(error));
      setWorking(false);
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
          <p>
            {data.activation
              ? data.activation.kind === "grandfathered"
                ? "Legacy pilot access"
                : `Batch ${data.activation.batch}`
              : "No kit activated"}
          </p>
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
          <button className="pixel-button" type="submit" disabled={working}>
            Save profile
          </button>
        </form>
      </Panel>

      <Panel>
        <h2>Your account data</h2>
        <p>Download the profile, activation, achievement, and progress data shown here.</p>
        <div className="button-row">
          <button className="pixel-button pixel-button--secondary" type="button" onClick={exportData}>
            Export JSON
          </button>
          <button
            className="pixel-button pixel-button--secondary"
            type="button"
            disabled={working}
            onClick={() => {
              void signOut();
            }}
          >
            <LogOut aria-hidden="true" /> Sign out
          </button>
        </div>
      </Panel>

      <Panel className="danger-panel">
        <h2>Delete account</h2>
        <p>
          This permanently removes the Supabase identity, profile, lesson progress, and compile
          records. A claimed code remains consumed and is de-identified so it cannot be reused.
        </p>
        <label className="identity-form">
          Type DELETE to confirm
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
          disabled={working || deleteConfirmation !== "DELETE"}
          onClick={() => {
            void deleteAccount();
          }}
        >
          Delete my account
        </button>
      </Panel>

      {feedback ? <StatusRegion>{feedback}</StatusRegion> : null}
    </div>
  );
}
