import {
  Cable,
  CheckCircle2,
  CloudCog,
  Eye,
  Send,
  TerminalSquare,
} from "lucide-react";
import type { ChangeEvent } from "react";
import type { HardwareWorkflowSnapshot } from "../hardware/workflow";
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
  readonly hardware: HardwareWorkflowSnapshot;
  readonly hardwareMessage: string;
  readonly observationConfirmed: boolean;
  readonly onCodeChange: (value: string) => void;
  readonly onChoiceChange: (value: string) => void;
  readonly onCheckQuiz: () => void;
  readonly onValidateCode: () => void;
  readonly onCompile: () => void;
  readonly onConnect: () => void;
  readonly onUpload: () => void;
  readonly onReadSerial: () => void;
  readonly onConfirmObservation: () => void;
}

function HardwareAction({
  icon,
  label,
  hardware,
  hardwareMessage,
  disabled,
  onAction,
}: {
  readonly icon: "compile" | "connect" | "upload";
  readonly label: string;
  readonly hardware: HardwareWorkflowSnapshot;
  readonly hardwareMessage: string;
  readonly disabled: boolean;
  readonly onAction: () => void;
}) {
  const Icon = icon === "compile" ? CloudCog : icon === "connect" ? Cable : Send;
  const busy = hardware.phase === "compiling" ||
    hardware.phase === "connecting" ||
    hardware.phase === "uploading";
  return (
    <div className="deferred-action">
      <Icon aria-hidden="true" />
      <button
        className="pixel-button"
        type="button"
        disabled={disabled || busy}
        aria-describedby="hardware-note hardware-action-status"
        onClick={onAction}
      >
        {label}
      </button>
      <p id="hardware-action-status" role="status" aria-live="polite">
        {hardware.error ?? hardwareMessage}
      </p>
      {hardware.progress ? (
        <p>
          Sending {hardware.progress.bytesWritten} of {hardware.progress.totalBytes} bytes…
        </p>
      ) : null}
      {busy ? (
        <small>The active action can be cancelled from the hardware state panel.</small>
      ) : null}
    </div>
  );
}

function serialCaptureAnnouncement(
  hardware: HardwareWorkflowSnapshot,
  baudRate: 9_600,
): string {
  if (!hardware.serial) return "";
  if (hardware.error) return `Serial capture error: ${hardware.error}`;
  if (hardware.serialReading) {
    return `Serial capture started at ${baudRate.toLocaleString("en-IE")} baud.`;
  }
  if (!hardware.device) return "Serial capture stopped before completion.";
  if (!hardware.serial.text.trim()) {
    return "Serial capture complete. No output was received.";
  }
  const unit = hardware.serial.bytesRead === 1 ? "byte" : "bytes";
  const limitMessage = hardware.serial.truncated
    ? " The capture reached the safe output limit."
    : "";
  return `Serial capture complete. ${hardware.serial.bytesRead.toLocaleString("en-IE")} ${unit} received.${limitMessage}`;
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
  hardwareMessage,
  observationConfirmed,
  onCodeChange,
  onChoiceChange,
  onCheckQuiz,
  onValidateCode,
  onCompile,
  onConnect,
  onUpload,
  onReadSerial,
  onConfirmObservation,
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
    /* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to focus and horizontally scroll the bounded table region. */
    case "wiring":
      return (
        <div className="wiring-step">
          <div className="wiring-map">
            <p className="wiring-map__description">{step.diagramAlt}</p>
            <div
              className="wiring-map__table-scroll"
              role="region"
              aria-label="Scrollable signal connection map"
              aria-describedby="signal-map-scroll-help"
              tabIndex={0}
            >
              <table>
                <caption>Verified signal connection map</caption>
                <thead>
                  <tr>
                    <th scope="col">Component</th>
                    <th scope="col">Signal</th>
                    <th scope="col">Nano pin</th>
                  </tr>
                </thead>
                <tbody>
                  {lesson.pinAssignments.map((assignment) => (
                    <tr key={`${assignment.component}-${assignment.signal}-${assignment.pin}`}>
                      <th scope="row">
                        {assignment.component}
                        {assignment.note ? <small>{assignment.note}</small> : null}
                      </th>
                      <td>{assignment.signal}</td>
                      <td><code>{assignment.pin}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <small id="signal-map-scroll-help">
              <span className="wiring-map__mobile-hint">
                On a narrow screen, swipe the map sideways or focus it and use the arrow keys. {" "}
              </span>
              This map covers controlled signal pins. Follow every ordered step below for
              power, ground, and disconnect instructions.
            </small>
          </div>
          <ol>
            {step.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
        </div>
      );
    /* eslint-enable jsx-a11y/no-noninteractive-tabindex */
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
      return (
        <HardwareAction
          icon="compile"
          label={hardware.phase === "compiling" ? "Compiling…" : "Compile sketch"}
          hardware={hardware}
          hardwareMessage={hardwareMessage}
          disabled={!canEdit || !hardware.capability.supported}
          onAction={onCompile}
        />
      );
    case "connect":
      return (
        <HardwareAction
          icon="connect"
          label={hardware.phase === "connecting" ? "Connecting…" : "Choose Nano"}
          hardware={hardware}
          hardwareMessage={hardwareMessage}
          disabled={!canEdit || !hardware.capability.supported || !hardware.artifact}
          onAction={onConnect}
        />
      );
    case "upload":
      return (
        <HardwareAction
          icon="upload"
          label={hardware.phase === "uploading" ? "Sending…" : "Send to board"}
          hardware={hardware}
          hardwareMessage={hardwareMessage}
          disabled={
            !canEdit ||
            !hardware.capability.supported ||
            !hardware.artifact ||
            !hardware.device
          }
          onAction={onUpload}
        />
      );
    case "serial-check":
      return (
        <div className="observation-step">
          <TerminalSquare aria-hidden="true" />
          <h3>Expected serial signal</h3>
          <p>{step.expectedObservation}</p>
          <button
            className="pixel-button pixel-button--secondary"
            type="button"
            disabled={
              !canEdit ||
              !hardware.evidence ||
              !hardware.device ||
              hardware.serialReading
            }
            onClick={onReadSerial}
          >
            {hardware.serialReading ? "Listening at 9600 baud…" : "Read serial output"}
          </button>
          <small>
            Firelight listens at {step.baudRate} baud for up to 10 seconds and caps each capture at 8 KiB.
          </small>
          <p
            className="sr-only"
            id="serial-capture-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {serialCaptureAnnouncement(hardware, step.baudRate)}
          </p>
          <pre
            className="serial-output"
            aria-label="Arduino serial output"
            aria-describedby="serial-capture-status"
            aria-busy={hardware.serialReading}
          >
            {hardware.serial?.text ?? "No serial output captured yet."}
          </pre>
          {hardware.serial?.truncated ? (
            <small>Capture stopped at the safe output limit.</small>
          ) : null}
          <button
            className="pixel-button"
            type="button"
            disabled={
              !canEdit ||
              !hardware.evidence ||
              !hardware.serial?.text.trim()
            }
            onClick={onConfirmObservation}
          >
            {observationConfirmed ? "Serial signal confirmed" : "I observed this signal"}
          </button>
          <small>
            Compare the captured values with the expected signal, then confirm what you observed.
          </small>
        </div>
      );
    case "manual-observation":
      return (
        <div className="observation-step">
          <Eye aria-hidden="true" />
          <h3>Check the real build</h3>
          <p>{step.prompt}</p>
          <button
            className="pixel-button"
            type="button"
            disabled={!canEdit || !hardware.evidence}
            onClick={onConfirmObservation}
          >
            {observationConfirmed ? "Observation confirmed" : "I observed this"}
          </button>
          <small>
            Observation unlocks after upload success. It is a learner confirmation, not device telemetry.
          </small>
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
