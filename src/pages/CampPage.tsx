import { ArrowRight, Award, Map, Radio } from "lucide-react";
import { Link } from "wouter";
import { HardwareStatus, PageIntro, Panel, ProgressBar, PixelLink } from "../components/ui";
import { useIdentity } from "../features/identity/identity-context";
import {
  deriveCurriculumProgress,
  deriveLessonAchievements,
  deriveNextLesson,
  getCurrentLessonProgress,
} from "../features/lessons/derivations";

export function CampPage() {
  const identity = useIdentity();
  const data = identity.data;
  if (!data) return null;

  const progress = deriveCurriculumProgress(data.progress);
  const nextLesson = deriveNextLesson(data.progress);
  const nextProgress = nextLesson
    ? getCurrentLessonProgress(nextLesson, data.progress)
    : undefined;
  const isResuming = nextProgress?.status === "in_progress";
  const achievements = deriveLessonAchievements(data.progress);
  const resumePath = nextLesson?.route ?? "/learn";

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
          <p className="eyebrow">
            {progress.completedLessons} of {progress.totalLessons} builds complete
          </p>
          <h2>
            {nextLesson ? `Next: ${nextLesson.title}` : "The core trail is complete!"}
          </h2>
          <p>
            {nextLesson
              ? isResuming
                ? "Continue from your saved checkpoint whenever the hardware is ready."
                : "Your next available build is ready whenever the hardware is."
              : "Every core checkpoint is glowing."}
          </p>
          <ProgressBar label="Core trail progress" value={progress.percentage} />
          <div className="button-row">
            <PixelLink to={resumePath}>
              {nextLesson ? (isResuming ? "Resume trail" : "Start trail") : "Review trail"}
            </PixelLink>
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
          <p>{nextLesson ? `Return to ${nextLesson.title}.` : "Review the completed trail."}</p>
          <span>Open lesson <ArrowRight aria-hidden="true" /></span>
        </Link>
        <Link className="panel path-card" to="/account">
          <Award aria-hidden="true" />
          <h2>Badges</h2>
          <p>{achievements.filter((achievement) => achievement.earned).length} earned.</p>
          <span>Open account <ArrowRight aria-hidden="true" /></span>
        </Link>
      </section>
    </div>
  );
}
