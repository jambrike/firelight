import { KeyRound, MailCheck, UserRound } from "lucide-react";
import { FeaturePlaceholder, PageIntro, Panel, PixelLink } from "../components/ui";

export function AuthPage() {
  return (
    <div className="page-section narrow-page page-stack">
      <PageIntro eyebrow="Set up camp" title="Your builds should be waiting when you return.">
        <p>
          This route is ready for Supabase signup, confirmation, login, and password
          recovery in the identity milestone.
        </p>
      </PageIntro>
      <FeaturePlaceholder label="Authentication foundation" title="Account services come next">
        <p>
          Milestone 1 deliberately does not fake a login or store a password in this
          browser. The next verified milestone will connect secure account services.
        </p>
      </FeaturePlaceholder>
      <div className="three-up compact-cards">
        <Panel>
          <UserRound aria-hidden="true" />
          <h2>Create a profile</h2>
          <p>Choose a builder name and sign up with email and password.</p>
        </Panel>
        <Panel>
          <MailCheck aria-hidden="true" />
          <h2>Confirm the camp</h2>
          <p>Production email confirmation prevents accidental or mistyped accounts.</p>
        </Panel>
        <Panel>
          <KeyRound aria-hidden="true" />
          <h2>Recover access</h2>
          <p>Reset forgotten passwords without local fallback credentials.</p>
        </Panel>
      </div>
      <div className="button-row">
        <PixelLink to="/activate">Preview activation</PixelLink>
        <PixelLink to="/" secondary>
          Return home
        </PixelLink>
      </div>
    </div>
  );
}
