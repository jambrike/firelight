import {
  Cable,
  CheckCircle2,
  CloudCog,
  Eye,
  Send,
  TerminalSquare,
} from "lucide-react";
import type { ChangeEvent } from "react";
import type { DeferredHardwareAvailability } from "../hardware/deferred";
import type { CodeValidationResult } from "./code-validation";
import type { LessonCatalogEntry } from "./catalog";
import type { LessonStep } from "./contracts";

interface LessonStepContentProps {
  readonly lesson: LessonCatalogEntry;
  readonly step: LessonStep;
  readonly code: string;
  readonly canEdit: boolean;
  readonly codeReadOnlyMessage: string;
  readonly selectedChoice: string | null;
  readonly quizChecked: boolean;
  readonly validation: CodeValidationResult | null;
  readonly hardware: DeferredHardwareAvailability;
  readonly onCodeChange: (value: string) => void;
  readonly onChoiceChange: (value: string) => void;
  readonly onCheckQuiz: () => void;
  readonly onValidateCode: () => void;
}

function DeferredAction({
  icon,
  label,
  hardware,
}: {
  readonly icon: "compile" | "connect" | "upload";
  readonly label: string;
  readonly hardware: DeferredHardwareAvailability;
}) {
  const Icon = icon === "compile" ? CloudCog : icon === "connect" ? Cable : Send;
  return (
    <div className="deferred-action">
      <Icon aria-hidden="true" />
      <button className="pixel-button" type="button" disabled aria-describedby="hardware-note">
        {label}
      </button>
      <p>{hardware.message}</p>
    </div>
  );
}

export function LessonStepContent({
  lesson,
  step,
  code,
  canEdit,
  codeReadOnlyMessage,
  selectedChoice,
  quizChecked,
  validation,
  hardware,
  onCodeChange,
  onChoiceChange,
  onCheckQuiz,
  onValidateCode,
}: LessonStepContentProps) {
  switch (step.type) {
    case "narrative":
      return (
        <div className="lesson-prose">
          <p className="lede">{step.body}</p>
          <h3>What you will be able to do</h3>
          <ul>
            {lesson.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </div>
      );
    case "wiring":
      return (
        <div className="wiring-step">
          <div className="wiring-diagram" role="img" aria-label={step.diagramAlt}>
            <span aria-hidden="true">NANO</span>
            <i aria-hidden="true" />
            <b aria-hidden="true">BUILD</b>
          </div>
          <ol>
            {step.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
        </div>
      );
    case "code-edit":
      return (
        <div className="code-workbench">
          <p id="code-editor-prompt">{step.prompt}</p>
          <label htmlFor="lesson-code-editor">Arduino sketch</label>
          <textarea
            id="lesson-code-editor"
            aria-describedby="code-editor-prompt code-editor-help"
            autoCapitalize="off"
            autoComplete="off"
            readOnly={!canEdit}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              onCodeChange(event.currentTarget.value);
            }}
            rows={22}
            spellCheck={false}
            value={code}
          />
          <small id="code-editor-help">
            {canEdit
              ? "Changes save after a short pause. Tab moves focus out of the editor."
              : codeReadOnlyMessage}
          </small>
        </div>
      );
    case "code-validation":
      return (
        <div className="check-workbench">
          <p>Run a fast lesson check before asking the compiler to build the sketch.</p>
          <button
            className="pixel-button"
            type="button"
            disabled={!canEdit}
            onClick={onValidateCode}
          >
            Check my code
          </button>
          {validation ? (
            <div
              className={validation.valid ? "validation-result success" : "validation-result error"}
              role="status"
              aria-live="polite"
            >
              {validation.valid ? (
                <p>
                  <CheckCircle2 aria-hidden="true" /> {step.successMessage}
                </p>
              ) : (
                <>
                  <p>There are {validation.messages.length} things to revisit:</p>
                  <ul>
                    {validation.messages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
        </div>
      );
    case "quiz": {
      const correct = selectedChoice === step.correctChoiceId;
      return (
        <fieldset className="lesson-quiz">
          <legend>{step.prompt}</legend>
          {step.choices.map((choice) => (
            <label key={choice.id}>
              <input
                type="radio"
                name={`quiz-${lesson.id}-${step.id}`}
                checked={selectedChoice === choice.id}
                onChange={() => {
                  onChoiceChange(choice.id);
                }}
              />
              <span>{choice.label}</span>
            </label>
          ))}
          <button
            className="pixel-button pixel-button--secondary"
            type="button"
            disabled={!selectedChoice}
            onClick={onCheckQuiz}
          >
            Check answer
          </button>
          {quizChecked ? (
            <p className={correct ? "quiz-feedback success" : "quiz-feedback error"} role="status">
              {correct ? "That’s it. Bank this idea and keep building." : "Not quite—trace what the circuit reads and try again."}
            </p>
          ) : null}
        </fieldset>
      );
    }
    case "compile":
      return <DeferredAction icon="compile" label="Compile sketch" hardware={hardware} />;
    case "connect":
      return <DeferredAction icon="connect" label="Choose Nano" hardware={hardware} />;
    case "upload":
      return <DeferredAction icon="upload" label="Send to board" hardware={hardware} />;
    case "serial-check":
      return (
        <div className="observation-step">
          <TerminalSquare aria-hidden="true" />
          <h3>Expected serial signal</h3>
          <p>{step.expectedObservation}</p>
          <button className="pixel-button" type="button" disabled>
            Open serial monitor
          </button>
          <small>Serial reading becomes available with the hardware transport.</small>
        </div>
      );
    case "manual-observation":
      return (
        <div className="observation-step">
          <Eye aria-hidden="true" />
          <h3>Check the real build</h3>
          <p>{step.prompt}</p>
          <button className="pixel-button" type="button" disabled>
            I observed this
          </button>
          <small>Observation unlocks after a verified upload.</small>
        </div>
      );
    case "completion":
      return (
        <div className="completion-step">
          <CheckCircle2 aria-hidden="true" />
          <p className="lede">{step.summary}</p>
          <p>Firelight will only complete this build after its required knowledge and hardware checks.</p>
        </div>
      );
  }
}
