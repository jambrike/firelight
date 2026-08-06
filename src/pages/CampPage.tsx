import { ArrowRight, Award, Map, Radio } from "lucide-react";
import { Link } from "wouter";
import { HardwareStatus, PageIntro, Panel, ProgressBar, PixelLink } from "../components/ui";
import { useIdentity } from "../features/identity/identity-context";
import { findCurriculumLesson } from "../../shared/curriculum";

export function CampPage() {
  const identity = useIdentity();
  const data = identity.data;
  if (!data) return null;

  const completed = new Set(
    data.progress
      .filter((item) => {
        const lesson = findCurriculumLesson(item.lessonId);
        return item.status === "completed" && lesson?.version === item.lessonVersion;
      })
      .map((item) => item.lessonId),
  ).size;
  const progressPercent = Math.round((completed / 6) * 100);
  const resumePath = data.nextLesson ? `/learn/${data.nextLesson.id}` : "/learn";

  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Learner camp" title={`Welcome back, ${data.profile.displayName}.`}>
        <p>Your profile and lesson checkpoints are synchronized across signed-in devices.</p>
      </PageIntro>

      {!data.activation ? (
        <Panel className="activation-callout">
          <span className="status-chip">Activation needed</span>
          <h2>Connect the kit before recording the trail.</h2>
          <p>You can preview every lesson now. One-time activation enables saved progress.</p>
          <PixelLink to="/activate">Activate kit</PixelLink>
        </Panel>
      ) : null}

      <section className="dashboard-grid" aria-label="Learner camp">
        <Panel className="camp-board">
          <span className="status-chip">{data.activation ? "Camp synchronized" : "Preview access"}</span>
          <p className="eyebrow">{completed} of 6 builds complete</p>
          <h2>
            {data.nextLesson ? `Next: ${data.nextLesson.title}` : "The core trail is complete!"}
          </h2>
          <p>
            {data.nextLesson
              ? "Continue from your next saved build whenever the hardware is ready."
              : "Every core checkpoint is glowing."}
          </p>
          <ProgressBar label="Core trail progress" value={progressPercent} />
          <div className="button-row">
            <PixelLink to={resumePath}>{data.nextLesson ? "Resume trail" : "Review trail"}</PixelLink>
            <PixelLink to="/learn" secondary>
              Open map
            </PixelLink>
          </div>
        </Panel>
        <Panel className="status-board">
          <p className="eyebrow">Hardware state</p>
          <HardwareStatus />
          <p className="muted-copy">
            A board is never reported as connected until Web Serial opens it in the hardware
            milestone.
          </p>
        </Panel>
      </section>

      <section className="three-up compact-cards" aria-label="Main camp paths">
        <Link className="panel path-card" to="/learn">
          <Map aria-hidden="true" />
          <h2>Learn</h2>
          <p>Walk the six-build trail in order.</p>
          <span>Open path <ArrowRight aria-hidden="true" /></span>
        </Link>
        <Link className="panel path-card" to={resumePath}>
          <Radio aria-hidden="true" />
          <h2>Build</h2>
          <p>Return to the next lesson foundation.</p>
          <span>Open lesson <ArrowRight aria-hidden="true" /></span>
        </Link>
        <Link className="panel path-card" to="/account">
          <Award aria-hidden="true" />
          <h2>Badges</h2>
          <p>{data.achievements.filter((achievement) => achievement.earned).length} earned.</p>
          <span>Open account <ArrowRight aria-hidden="true" /></span>
        </Link>
      </section>
    </div>
  );
}
