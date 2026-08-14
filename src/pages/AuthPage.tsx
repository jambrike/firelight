import { KeyRound, MailCheck, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { useLocation } from "wouter";
import { PageIntro, Panel, PixelLink, StatusRegion } from "../components/ui";
import { useIdentity } from "../features/identity/identity-context";

type AuthMode = "signup" | "login" | "forgot" | "reset";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Firelight could not complete the request.";
}

function clearRecoveryParameters(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("mode");
  url.searchParams.delete("code");
  url.searchParams.delete("sb_flow_id");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function requestedTutorialPath(): string | null {
  const requested = new URLSearchParams(window.location.search).get("next");
  return requested === "/learn/first-spark" ? requested : null;
}

export function AuthPage() {
  const identity = useIdentity();
  const [, navigate] = useLocation();
  const tutorialPath = requestedTutorialPath();
  const [mode, setMode] = useState<AuthMode>(() =>
    identity.recoveryMode || new URLSearchParams(window.location.search).get("mode") === "reset"
      ? "reset"
      : "login",
  );
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (
      tutorialPath &&
      identity.status === "authenticated" &&
      identity.data &&
      mode !== "reset"
    ) {
      navigate(tutorialPath, { replace: true });
    }
  }, [identity.data, identity.status, mode, navigate, tutorialPath]);

  const submit = async () => {
    setSubmitting(true);
    setFeedback(null);
    try {
      if (mode === "signup") {
        await identity.signUp(email.trim(), password, displayName.trim());
        setFeedback("Account created. Check your email if confirmation is required.");
      } else if (mode === "login") {
        await identity.signIn(email.trim(), password);
        setFeedback("Signed in. Your camp is loading.");
      } else if (mode === "forgot") {
        await identity.requestPasswordReset(email.trim());
        setFeedback("Check your email for a secure reset link.");
      } else {
        await identity.updatePassword(password);
        clearRecoveryParameters();
        setFeedback("Password updated. Your camp is ready.");
        setMode("login");
        setPassword("");
      }
    } catch (submitError) {
      setFeedback(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    void submit();
  };

  if (identity.status === "authenticated" && identity.data && mode !== "reset") {
    return (
      <div className="page-section narrow-page page-stack">
        <PageIntro eyebrow="Camp lit" title={`Welcome back, ${identity.data.profile.displayName}.`}>
          <p>Your Supabase session is active and your saved trail is ready.</p>
        </PageIntro>
        <Panel>
          <p>
            Signed in as <strong>{identity.data.profile.email}</strong>
          </p>
          <div className="button-row">
            <PixelLink to={identity.data.activation ? "/camp" : "/activate"}>
              {identity.data.activation ? "Open camp" : "Activate kit"}
            </PixelLink>
            <PixelLink to="/account" secondary>
              Account settings
            </PixelLink>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page-section narrow-page page-stack">
      <PageIntro eyebrow="Set up camp" title="Your builds should be waiting when you return.">
        <p>Create a secure account or sign in to synchronize your Firelight trail.</p>
      </PageIntro>

      <div className="auth-mode-tabs" aria-label="Account action">
        <button
          type="button"
          className={mode === "login" ? "active" : undefined}
          aria-pressed={mode === "login"}
          onClick={() => {
            setMode("login");
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          className={mode === "signup" ? "active" : undefined}
          aria-pressed={mode === "signup"}
          onClick={() => {
            setMode("signup");
          }}
        >
          Create account
        </button>
        <button
          type="button"
          className={mode === "forgot" ? "active" : undefined}
          aria-pressed={mode === "forgot"}
          onClick={() => {
            setMode("forgot");
          }}
        >
          Reset password
        </button>
      </div>

      <Panel>
        <form className="identity-form" onSubmit={handleSubmit}>
          <h2>
            {mode === "signup"
              ? "Create your builder profile"
              : mode === "forgot"
                ? "Send a recovery link"
                : mode === "reset"
                  ? "Choose a new password"
                  : "Return to your camp"}
          </h2>
          {mode === "signup" ? (
            <label>
              Builder name
              <input
                name="displayName"
                autoComplete="name"
                maxLength={40}
                required
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.currentTarget.value);
                }}
              />
            </label>
          ) : null}
          {mode !== "reset" ? (
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.currentTarget.value);
                }}
              />
            </label>
          ) : null}
          {mode !== "forgot" ? (
            <label>
              {mode === "reset" ? "New password" : "Password"}
              <input
                name="password"
                type="password"
                minLength={8}
                required
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value);
                }}
              />
              <small>Use at least 8 characters with letters and numbers.</small>
            </label>
          ) : null}
          <button className="pixel-button" type="submit" disabled={submitting}>
            {submitting
              ? "Working…"
              : mode === "signup"
                ? "Create account"
                : mode === "forgot"
                  ? "Send reset link"
                  : mode === "reset"
                    ? "Update password"
                    : "Sign in"}
          </button>
          {feedback || identity.notice || identity.error ? (
            <StatusRegion>{feedback ?? identity.notice ?? identity.error}</StatusRegion>
          ) : null}
        </form>
      </Panel>

      <div className="three-up compact-cards">
        <Panel>
          <UserRound aria-hidden="true" />
          <h2>One profile</h2>
          <p>Your builder name and lesson checkpoints follow you between devices.</p>
        </Panel>
        <Panel>
          <MailCheck aria-hidden="true" />
          <h2>Email confirmation</h2>
          <p>Production accounts require a confirmed address before sign-in.</p>
        </Panel>
        <Panel>
          <KeyRound aria-hidden="true" />
          <h2>Safe recovery</h2>
          <p>Password resets use expiring links. Firelight stores no local fallback password.</p>
        </Panel>
      </div>
    </div>
  );
}
