import { Database, PackageCheck, UserRound } from "lucide-react";
import { FeaturePlaceholder, PageIntro, Panel, PixelLink } from "../components/ui";

export function AccountPage() {
  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Builder account" title="One place for your profile, kit, and data.">
        <p>
          The page structure is ready; authenticated reads and writes begin in the
          identity milestone.
        </p>
      </PageIntro>
      <FeaturePlaceholder label="Account data foundation" title="No learner data is loaded yet">
        <p>
          This preview does not infer an identity from local storage. Supabase sessions
          and Row Level Security will become the source of truth.
        </p>
      </FeaturePlaceholder>
      <section className="three-up compact-cards">
        <Panel>
          <UserRound aria-hidden="true" />
          <h2>Profile</h2>
          <p>Display name, email state, and account recovery.</p>
        </Panel>
        <Panel>
          <PackageCheck aria-hidden="true" />
          <h2>Connected kit</h2>
          <p>Claim state and pilot support details without exposing the kit code.</p>
        </Panel>
        <Panel>
          <Database aria-hidden="true" />
          <h2>Your data</h2>
          <p>Export progress or request secure account deletion.</p>
        </Panel>
      </section>
      <PixelLink to="/auth">Open account entry</PixelLink>
    </div>
  );
}
