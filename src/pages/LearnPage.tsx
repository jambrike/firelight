import { ArrowRight, LockKeyhole } from "lucide-react";
import { Link } from "wouter";
import { PageIntro } from "../components/ui";
import { lessonCatalog } from "../features/lessons/catalog";

export function LearnPage() {
  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Firelight build path" title="Where the real building lives.">
        <p>
          Preview all six projects now. Signed-in builders will unlock them in order as
          checkpoints are completed.
        </p>
      </PageIntro>
      <ol className="lesson-trail">
        {lessonCatalog.map((lesson) => (
          <li key={lesson.id} data-lesson={lesson.id}>
            <Link to={`/learn/${lesson.id}`} className="lesson-card">
              <span className="lesson-card__number">
                {lesson.order.toString().padStart(2, "0")}
              </span>
              <span className="lesson-card__art" aria-hidden="true" />
              <span className="lesson-card__body">
                <span className="lesson-card__meta">
                  {lesson.estimatedMinutes} min
                  {lesson.migrationStage === "planned" ? (
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
        ))}
      </ol>
    </div>
  );
}
