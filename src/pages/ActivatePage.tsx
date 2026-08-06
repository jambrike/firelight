import { PackageCheck } from "lucide-react";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { PageIntro, Panel, PixelLink, StatusRegion } from "../components/ui";
import { useIdentity } from "../features/identity/identity-context";

function formatCode(value: string): string {
  const canonical = value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 16);
  return canonical.match(/.{1,4}/g)?.join("-") ?? canonical;
}

export function ActivatePage() {
  const identity = useIdentity();
  const [code, setCode] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const activation = identity.data?.activation ?? null;

  const submit = async () => {
    setSubmitting(true);
    setFeedback(null);
    try {
      await identity.claimKit(code);
      setFeedback("Kit activated. Your full camp is ready.");
      setCode("");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Kit activation failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    void submit();
  };

  return (
    <div className="page-section narrow-page page-stack">
      <PageIntro eyebrow="One-time kit activation" title="Match this kit to your camp.">
        <p>
          Each pilot kit includes one 16-character code. It unlocks synchronized
          progress and, in the hardware milestone, secure compilation.
        </p>
      </PageIntro>

      {activation ? (
        <Panel>
          <PackageCheck aria-hidden="true" />
          <span className="status-chip">Activated</span>
          <h2>{activation.kind === "grandfathered" ? "Pilot access preserved" : "Kit connected"}</h2>
          <p>
            Access source: {activation.kind === "grandfathered" ? "Legacy pilot" : activation.batch}
          </p>
          <PixelLink to="/camp">Open your camp</PixelLink>
        </Panel>
      ) : (
        <Panel>
          <PackageCheck aria-hidden="true" />
          <form className="identity-form" onSubmit={handleSubmit}>
            <h2>Enter the code inside your box</h2>
            <label>
              Kit code
              <input
                className="code-input"
                name="code"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="ABCD-EFGH-JKMP-NRST"
                value={code}
                onChange={(event) => {
                  setCode(formatCode(event.currentTarget.value));
                }}
                minLength={19}
                maxLength={19}
                required
              />
            </label>
            <p>
              The plaintext code is sent once over HTTPS. Firelight stores only a
              server-peppered HMAC and never returns the code.
            </p>
            <button className="pixel-button" type="submit" disabled={submitting}>
              {submitting ? "Checking code…" : "Activate kit"}
            </button>
            {feedback ? <StatusRegion>{feedback}</StatusRegion> : null}
          </form>
        </Panel>
      )}

      <PixelLink to="/kit" secondary>
        Check kit and browser requirements
      </PixelLink>
    </div>
  );
}
