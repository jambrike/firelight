import { Link } from "wouter";
import { PageIntro } from "../components/ui";

export function NotFoundPage() {
  return (
    <div className="page-section narrow-page page-stack">
      <PageIntro eyebrow="Trail marker missing" title="This path ends in the woods.">
        <p>The page may have moved, or the campfire story sent you to an old trail.</p>
      </PageIntro>
      <Link className="pixel-button" to="/">
        Return to the fire
      </Link>
    </div>
  );
}
