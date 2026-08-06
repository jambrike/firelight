import { Cable, CloudCog, Send, Wrench } from "lucide-react";
import { Link, useParams } from "wouter";
import {
  FeaturePlaceholder,
  HardwareStatus,
  PageIntro,
  Panel,
  StatusRegion,
} from "../components/ui";
import { FIRELIGHT_BOARD_FQBN, FIRELIGHT_UPLOAD_BAUD } from "../features/hardware/contracts";
import { findLesson } from "../features/lessons/catalog";

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
        eyebrow={`Build ${lesson.order.toString().padStart(2, "0")} · ${lesson.estimatedMinutes.toString()} minutes`}
        title={lesson.title}
      >
        <p>{lesson.summary}</p>
      </PageIntro>

      <section className="lesson-layout">
        <div className="lesson-main">
          <FeaturePlaceholder label="Lesson engine foundation" title="Shared lesson workspace">
            <p>
              Narrative, wiring, code editing, validation, quiz, compile, connect,
              upload, serial, observation, and completion steps now have typed
              boundaries. The engine and content ship in later milestones.
            </p>
          </FeaturePlaceholder>

          <Panel className="ritual-panel">
            <p className="eyebrow">The build ritual</p>
            <h2>Compile → Connect → Send</h2>
            <ol className="ritual-steps">
              <li>
                <CloudCog aria-hidden="true" />
                <strong>Compile</strong>
                <small>Turn checked Arduino code into an Intel HEX artifact.</small>
              </li>
              <li>
                <Cable aria-hidden="true" />
                <strong>Connect</strong>
                <small>Choose the Nano through desktop Web Serial.</small>
              </li>
              <li>
                <Send aria-hidden="true" />
                <strong>Send</strong>
                <small>Upload at {FIRELIGHT_UPLOAD_BAUD.toLocaleString()} baud and verify.</small>
              </li>
            </ol>
            <StatusRegion>Hardware actions are intentionally inactive in this foundation milestone.</StatusRegion>
          </Panel>
        </div>

        <aside className="lesson-sidebar">
          <Panel>
            <p className="eyebrow">Board target</p>
            <HardwareStatus />
            <code>{FIRELIGHT_BOARD_FQBN}</code>
          </Panel>
          <Panel>
            <Wrench aria-hidden="true" />
            <p className="eyebrow">Parts</p>
            <ul>
              {lesson.parts.map((part) => (
                <li key={part}>{part}</li>
              ))}
            </ul>
          </Panel>
          <Panel>
            <p className="eyebrow">Fixed pin map</p>
            <dl className="pin-map">
              {lesson.pins.map((assignment) => (
                <div key={`${assignment.component}-${assignment.signal}`}>
                  <dt>
                    {assignment.component} · {assignment.signal}
                  </dt>
                  <dd>{assignment.pin}</dd>
                  {assignment.note ? <small>{assignment.note}</small> : null}
                </div>
              ))}
            </dl>
          </Panel>
        </aside>
      </section>
    </div>
  );
}
