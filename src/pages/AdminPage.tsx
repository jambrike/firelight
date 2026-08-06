import { FileClock, KeySquare, Search, TriangleAlert } from "lucide-react";
import { FeaturePlaceholder, PageIntro, Panel } from "../components/ui";

export function AdminPage() {
  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Pilot support" title="A small console for keeping builders moving.">
        <p>
          This route exposes no operational data until server-verified admin roles and
          audit logging are implemented.
        </p>
      </PageIntro>
      <FeaturePlaceholder label="Admin authorization foundation" title="Admin access is not active">
        <p>
          A later milestone will enforce role checks in both the Worker and PostgreSQL.
          Hiding a client-side link will never count as authorization.
        </p>
      </FeaturePlaceholder>
      <section className="four-up compact-cards" aria-label="Planned support tools">
        <Panel>
          <KeySquare aria-hidden="true" />
          <h2>Kit batches</h2>
          <p>Create, export once, and revoke pilot activation codes.</p>
        </Panel>
        <Panel>
          <Search aria-hidden="true" />
          <h2>Learner lookup</h2>
          <p>Inspect activation and lesson progress for support.</p>
        </Panel>
        <Panel>
          <TriangleAlert aria-hidden="true" />
          <h2>Compile failures</h2>
          <p>Review safe diagnostics without retaining source code.</p>
        </Panel>
        <Panel>
          <FileClock aria-hidden="true" />
          <h2>Audit history</h2>
          <p>Track privileged actions with actor and target metadata.</p>
        </Panel>
      </section>
    </div>
  );
}
