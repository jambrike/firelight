import { ArrowRight, CheckCircle2, LockKeyhole } from "lucide-react";
import { Link } from "wouter";
import { PageIntro } from "../components/ui";
import { lessonCatalog } from "../features/lessons/catalog";
import {
  deriveLessonAccessState,
  derivePrerequisiteState,
  getCurrentLessonProgress,
} from "../features/lessons/derivations";
import { useIdentity } from "../features/identity/identity-context";

export function LearnPage() {
  const identity = useIdentity();

  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Firelight build path" title="Where the real building lives.">
        <p>
          Preview all six projects now. Signed-in builders see synchronized checkpoints
          and the prerequisite trail that unlocks each build.
        </p>
      </PageIntro>
      <ol className="lesson-trail">
        {lessonCatalog.map((lesson) => {
          const progress = identity.data?.progress ?? [];
          const saved = getCurrentLessonProgress(lesson, progress);
          const access = identity.data
            ? deriveLessonAccessState(lesson, progress)
            : "preview";
          const prerequisites = identity.data
            ? derivePrerequisiteState(lesson, progress)
            : null;
          const missingTitles = prerequisites?.missing.map(
            (id) => lessonCatalog.find((candidate) => candidate.id === id)?.title ?? id,
          );

          return (
          <li key={lesson.id} data-lesson={lesson.id} data-status={access}>
            <Link to={lesson.route} className="lesson-card">
              <span className="lesson-card__number">
                {lesson.order.toString().padStart(2, "0")}
              </span>
              <span className="lesson-card__art" aria-hidden="true" />
              <span className="lesson-card__body">
                <span className="lesson-card__meta">
                  {lesson.estimatedMinutes} min
                  {access === "completed" ? (
                    <span>
                      <CheckCircle2 aria-hidden="true" /> Complete
                    </span>
                  ) : access === "in-progress" && saved ? (
                    <span>{Math.round(saved.percentage)}% saved</span>
                  ) : access === "locked" ? (
                    <span>
                      <LockKeyhole aria-hidden="true" /> Requires {missingTitles?.join(" and ")}
                    </span>
                  ) : access === "available" ? (
                    <span>Ready to begin</span>
                  ) : (
                    <span>Preview lesson</span>
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
