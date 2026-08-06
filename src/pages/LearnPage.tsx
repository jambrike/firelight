import { ArrowRight, CheckCircle2, LockKeyhole } from "lucide-react";
import { Link } from "wouter";
import { PageIntro } from "../components/ui";
import { lessonCatalog } from "../features/lessons/catalog";
import { useIdentity } from "../features/identity/identity-context";

export function LearnPage() {
  const identity = useIdentity();

  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Firelight build path" title="Where the real building lives.">
        <p>
          Preview all six projects now. Signed-in builders see their synchronized
          checkpoints; prerequisite enforcement arrives with the lesson engine.
        </p>
      </PageIntro>
      <ol className="lesson-trail">
        {lessonCatalog.map((lesson) => {
          const saved = identity.data?.progress.find(
            (progress) => progress.lessonId === lesson.id && progress.lessonVersion === 1,
          );
          return (
          <li key={lesson.id} data-lesson={lesson.id} data-status={saved?.status ?? "preview"}>
            <Link to={`/learn/${lesson.id}`} className="lesson-card">
              <span className="lesson-card__number">
                {lesson.order.toString().padStart(2, "0")}
              </span>
              <span className="lesson-card__art" aria-hidden="true" />
              <span className="lesson-card__body">
                <span className="lesson-card__meta">
                  {lesson.estimatedMinutes} min
                  {saved?.status === "completed" ? (
                    <span>
                      <CheckCircle2 aria-hidden="true" /> Complete
                    </span>
                  ) : saved?.status === "in_progress" ? (
                    <span>{saved.percentage}% saved</span>
                  ) : lesson.migrationStage === "planned" ? (
                    <span>
                      <LockKeyhole aria-hidden="true" /> Content milestone
                    </span>
                  ) : (
                    <span>Prototype source ready</span>
                  )}
                </span>
                <strong>{lesson.title}</strong>
                <small>{lesson.summary}</small>
                <span className="concept-row">
                  {lesson.concepts.map((concept) => (
                    <span key={concept}>{concept}</span>
                  ))}
                </span>
              </span>
              <ArrowRight className="lesson-card__arrow" aria-hidden="true" />
            </Link>
          </li>
          );
        })}
      </ol>
    </div>
  );
}
