import { Clock3, Cpu, Route } from "lucide-react";
import { Link, useParams } from "wouter";
import { PageIntro } from "../components/ui";
import { FIRELIGHT_BOARD_FQBN } from "../features/hardware/contracts";
import { findLesson } from "../features/lessons/catalog";
import { LessonWorkspace } from "../features/lessons/LessonWorkspace";

export function LessonPage() {
  const { lesson: lessonId } = useParams<"/learn/:lesson">();
  const lesson = findLesson(lessonId);

  if (!lesson) {
    return (
      <div className="page-section narrow-page page-stack">
        <PageIntro eyebrow="Trail marker missing" title="That lesson is not on this path.">
          <p>Choose one of the six supported Firelight builds from the curriculum map.</p>
        </PageIntro>
        <Link className="pixel-button" to="/learn">
          Return to the trail
        </Link>
      </div>
    );
  }

  return (
    <div className="page-section page-stack lesson-page" data-lesson={lesson.id}>
      <PageIntro
        eyebrow={`Build ${lesson.order.toString().padStart(2, "0")} · structured pilot lesson`}
        title={lesson.title}
      >
        <p>{lesson.summary}</p>
      </PageIntro>
      <div className="lesson-meta" role="list" aria-label="Lesson details">
        <span role="listitem"><Clock3 aria-hidden="true" /> {lesson.estimatedMinutes} minutes</span>
        <span role="listitem"><Route aria-hidden="true" /> {lesson.steps.length} guided steps</span>
        <span role="listitem"><Cpu aria-hidden="true" /> {FIRELIGHT_BOARD_FQBN}</span>
      </div>
      <LessonWorkspace key={lesson.id} lesson={lesson} />
    </div>
  );
}
