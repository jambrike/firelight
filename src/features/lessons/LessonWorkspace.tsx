import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  LockKeyhole,
  RotateCcw,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "wouter";
import type { LessonProgress } from "../../../shared/identity";
import { HardwareStatus, Panel, ProgressBar } from "../../components/ui";
import { FIRELIGHT_BOARD_FQBN } from "../hardware/contracts";
import { getHardwareCapabilityGuidance } from "../hardware/web-serial";
import { useHardwareWorkflowFactory } from "../hardware/workflow-context";
import { useIdentity } from "../identity/identity-context";
import { useProgressAutosave } from "../progress";
import type { ProgressDraft } from "../progress";
import type { CodeValidationResult } from "./code-validation";
import { validateLessonCode } from "./code-validation";
import { findLesson } from "./catalog";
import type { LessonCatalogEntry } from "./catalog";
import {
  derivePrerequisiteState,
  getCurrentLessonProgress,
} from "./derivations";
import { LessonStepContent } from "./LessonStepContent";
import { createMorseNameStarterCode } from "./morse";

const NARROW_LESSON_VIEWPORT = "(max-width: 48rem)";

function findSavedStepIndex(
  lesson: LessonCatalogEntry,
  progress: LessonProgress | null,
): number {
  if (!progress) return 0;
  if (progress.status === "completed") return Math.max(0, lesson.steps.length - 1);
  const index = lesson.steps.findIndex((step) => step.id === progress.currentStep);
  return index >= 0 ? index : 0;
}

function percentageAt(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(99, Math.floor((index / total) * 100));
}

export function LessonWorkspace({ lesson }: { readonly lesson: LessonCatalogEntry }) {
  const identity = useIdentity();
  const progress = identity.data?.progress ?? [];
  const savedProgress = getCurrentLessonProgress(lesson, progress) ?? null;
  const prerequisiteState = derivePrerequisiteState(lesson, progress);
  const canRecord =
    identity.status === "authenticated" &&
    identity.data?.activation != null &&
    prerequisiteState.satisfied;
  const draftOwnerId = identity.data?.profile.id ?? null;
  const completionScope = `${draftOwnerId ?? "anonymous"}:${lesson.id}:${String(lesson.version)}`;
  const personalizedStarterCode = lesson.id === "morse-name"
    ? createMorseNameStarterCode(identity.data?.profile.displayName ?? "")
    : lesson.starterCode;
  const [queuedCompletionScope, setQueuedCompletionScope] = useState<string | null>(null);
  const initialStepIndex = findSavedStepIndex(lesson, savedProgress);
  const [displayStepIndex, setDisplayStepIndex] = useState(initialStepIndex);
  const [checkpointStepIndex, setCheckpointStepIndex] = useState(initialStepIndex);
  const [checkpointPercentage, setCheckpointPercentage] = useState(
    savedProgress?.percentage ?? percentageAt(initialStepIndex, lesson.steps.length),
  );
  const [code, setCode] = useState(
    savedProgress?.codeSnapshot ?? personalizedStarterCode,
  );
  const hasEditedCodeRef = useRef(false);
  const lastPersonalizedStarterRef = useRef(personalizedStarterCode);
  const [validation, setValidation] = useState<CodeValidationResult | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [quizChecked, setQuizChecked] = useState(false);
  const [stageFocusRequest, setStageFocusRequest] = useState(0);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const [completedStepIds, setCompletedStepIds] = useState<ReadonlySet<string>>(() => {
    const completed = new Set(
      lesson.steps.slice(0, initialStepIndex).map((step) => step.id),
    );
    if (savedProgress?.status === "completed") {
      for (const step of lesson.steps) completed.add(step.id);
    }
    return completed;
  });
  const highestAppliedRevisionRef = useRef(savedProgress?.revision ?? 0);
  const hydratedProgressRef = useRef(savedProgress !== null);
  const queuedInitialRef = useRef(false);
  const accessToken = identity.session?.access_token ?? null;
  const workflowFactory = useHardwareWorkflowFactory();
  const hardwareWorkflow = useMemo(
    () => workflowFactory(() => accessToken),
    [accessToken, workflowFactory],
  );
  const hardware = useSyncExternalStore(
    hardwareWorkflow.subscribe,
    hardwareWorkflow.getSnapshot,
    hardwareWorkflow.getSnapshot,
  );
  const [observedStepIds, setObservedStepIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => () => {
    void hardwareWorkflow.dispose();
  }, [hardwareWorkflow]);

  useEffect(() => {
    if (stageFocusRequest === 0) return;
    const heading = stageHeadingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ behavior: "auto", block: "start" });
  }, [stageFocusRequest]);

  const resolveConflict = async () => {
    const bootstrap = await identity.refresh();
    const newest = getCurrentLessonProgress(lesson, bootstrap.progress) ?? null;
    if (newest && newest.revision > highestAppliedRevisionRef.current) {
      highestAppliedRevisionRef.current = newest.revision;
      const nextIndex = findSavedStepIndex(lesson, newest);
      setCheckpointStepIndex((current) => Math.max(current, nextIndex));
      setCheckpointPercentage((current) => Math.max(current, newest.percentage));
      setCompletedStepIds((current) => {
        const completed = new Set(current);
        const end = newest.status === "completed" ? lesson.steps.length : nextIndex;
        for (const completedStep of lesson.steps.slice(0, end)) {
          completed.add(completedStep.id);
        }
        return completed;
      });
    }
    return newest;
  };

  const autosave = useProgressAutosave({
    lessonId: lesson.id,
    lessonVersion: lesson.version,
    initialProgress: savedProgress,
    saveProgress: (lessonId, input) => identity.saveProgress(lessonId, input),
    resolveConflict,
    draftOwnerId,
  });
  const { queue: queueAutosave } = autosave;
  const isCompleted =
    savedProgress?.status === "completed" ||
    queuedCompletionScope === completionScope ||
    autosave.status.restoredDraft?.status === "completed";
  const canModify = canRecord && !isCompleted;

  useEffect(() => {
    if (lastPersonalizedStarterRef.current === personalizedStarterCode) return;
    lastPersonalizedStarterRef.current = personalizedStarterCode;
    if (
      lesson.id !== "morse-name" ||
      savedProgress !== null ||
      autosave.status.restoredDraft !== null ||
      hasEditedCodeRef.current
    ) {
      return;
    }
    setCode(personalizedStarterCode);
    if (canModify && queuedInitialRef.current) {
      queueAutosave({
        status: "in_progress",
        currentStep: lesson.steps[checkpointStepIndex]?.id ?? lesson.steps[0]?.id ?? "meet-the-build",
        percentage: checkpointPercentage,
        codeSnapshot: personalizedStarterCode,
      });
    }
  }, [
    autosave.status.restoredDraft,
    canModify,
    checkpointPercentage,
    checkpointStepIndex,
    lesson,
    personalizedStarterCode,
    queueAutosave,
    savedProgress,
  ]);

  /* eslint-disable react-hooks/set-state-in-effect -- A durable external-store snapshot must hydrate the editable workspace before input. */
  useEffect(() => {
    const restored = autosave.status.restoredDraft;
    if (!restored) return;
    hydratedProgressRef.current = true;
    queuedInitialRef.current = true;
    const savedStepIndex = lesson.steps.findIndex(
      (item) => item.id === restored.currentStep,
    );
    const restoredIndex =
      restored.status === "completed"
        ? Math.max(0, lesson.steps.length - 1)
        : Math.max(0, savedStepIndex);
    setDisplayStepIndex(restoredIndex);
    setCheckpointStepIndex(restoredIndex);
    setCheckpointPercentage(restored.percentage);
    if (Object.prototype.hasOwnProperty.call(restored, "codeSnapshot")) {
      setCode(restored.codeSnapshot ?? personalizedStarterCode);
      hasEditedCodeRef.current = restored.codeSnapshot !== null;
    }
    setValidation(null);
    setSelectedChoice(null);
    setQuizChecked(false);
    setCompletedStepIds(() => {
      const end = restored.status === "completed" ? lesson.steps.length : restoredIndex;
      return new Set(lesson.steps.slice(0, end).map((item) => item.id));
    });
  }, [autosave.status.restoredDraft, lesson, personalizedStarterCode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (hydratedProgressRef.current || !savedProgress || autosave.status.dirty) return;
    hydratedProgressRef.current = true;
    queuedInitialRef.current = true;
    highestAppliedRevisionRef.current = Math.max(
      highestAppliedRevisionRef.current,
      savedProgress.revision,
    );
    const resumedIndex = findSavedStepIndex(lesson, savedProgress);
    setDisplayStepIndex(resumedIndex);
    setCheckpointStepIndex(resumedIndex);
    setCheckpointPercentage(savedProgress.percentage);
    setCode(savedProgress.codeSnapshot ?? personalizedStarterCode);
    hasEditedCodeRef.current = savedProgress.codeSnapshot !== null;
    setValidation(null);
    setSelectedChoice(null);
    setQuizChecked(false);
    setCompletedStepIds(() => {
      const end = savedProgress.status === "completed" ? lesson.steps.length : resumedIndex;
      return new Set(lesson.steps.slice(0, end).map((item) => item.id));
    });
  }, [autosave.status.dirty, lesson, personalizedStarterCode, savedProgress]);

  const queueProgress = (draft: ProgressDraft) => {
    if (!canModify) return;
    queueAutosave(draft);
  };

  useEffect(() => {
    if (!canModify || savedProgress || queuedInitialRef.current) return;
    const firstStep = lesson.steps[0];
    if (!firstStep) return;
    queuedInitialRef.current = true;
    queueAutosave({
      status: "in_progress",
      currentStep: firstStep.id,
      percentage: 0,
      codeSnapshot: hasEditedCodeRef.current ? code : personalizedStarterCode,
    });
  }, [
    canModify,
    code,
    lesson.steps,
    personalizedStarterCode,
    queueAutosave,
    savedProgress,
  ]);

  const step = lesson.steps[displayStepIndex] ?? lesson.steps[0];
  if (!step) return null;
  const checkpointStep = lesson.steps[checkpointStepIndex] ?? lesson.steps[0];
  if (!checkpointStep) return null;

  const stepCanAdvance = (() => {
    if (!canModify || displayStepIndex !== checkpointStepIndex) return false;
    if (step.type === "compile") return hardware.artifact !== null;
    if (step.type === "connect") return hardware.device !== null;
    if (step.type === "upload") return hardware.evidence !== null;
    if (step.type === "serial-check" || step.type === "manual-observation") {
      return hardware.evidence !== null && observedStepIds.has(step.id);
    }
    if (step.type === "code-validation") return validation?.valid === true;
    if (step.type === "quiz") {
      return quizChecked && selectedChoice === step.correctChoiceId;
    }
    if (step.type === "completion") {
      return hardware.evidence !== null &&
        step.requiredStepIds.every((id) => completedStepIds.has(id));
    }
    return true;
  })();

  const advance = () => {
    if (!stepCanAdvance) return;
    const finishedIds = new Set(completedStepIds);
    finishedIds.add(step.id);
    setCompletedStepIds(finishedIds);

    if (step.type === "completion") {
      setCheckpointPercentage(100);
      setQueuedCompletionScope(completionScope);
      queueProgress({
        status: "completed",
        currentStep: step.id,
        percentage: 100,
        codeSnapshot: code,
        ...(hardware.evidence ? { uploadEvidenceId: hardware.evidence.id } : {}),
      });
      return;
    }

    const nextIndex = Math.min(checkpointStepIndex + 1, lesson.steps.length - 1);
    const nextStep = lesson.steps[nextIndex];
    if (!nextStep) return;
    const nextPercentage = Math.max(
      checkpointPercentage,
      percentageAt(nextIndex, lesson.steps.length),
    );
    setCheckpointStepIndex(nextIndex);
    setCheckpointPercentage(nextPercentage);
    setDisplayStepIndex(nextIndex);
    setValidation(null);
    setQuizChecked(false);
    setSelectedChoice(null);
    queueProgress({
      status: "in_progress",
      currentStep: nextStep.id,
      percentage: nextPercentage,
      codeSnapshot: code,
    });
  };

  const accessMessage = (() => {
    if (identity.status === "loading") return "Checking your camp access…";
    if (identity.status !== "authenticated") return "Preview mode · sign in to edit and save";
    if (!identity.data) return "Checking your camp access…";
    if (!identity.data.activation) return "Preview mode · activate a kit to edit and save";
    if (!prerequisiteState.satisfied) {
      return `Preview mode · complete ${prerequisiteState.missing
        .map((id) => findLesson(id)?.title ?? id.replaceAll("-", " "))
        .join(", ")} first`;
    }
    if (isCompleted) return "Review mode · this lesson is complete";
    return "Builder mode · progress sync is on";
  })();

  const workspaceAccess = canRecord ? (isCompleted ? "review" : "builder") : "preview";
  const codeReadOnlyMessage = isCompleted
    ? "This completed sketch is read-only. You can focus and copy it while reviewing."
    : "This preview sketch is read-only. You can focus and copy it; unlock builder mode to edit.";
  const hardwareMessage = (() => {
    if (!hardware.capability.supported) {
      return getHardwareCapabilityGuidance(hardware.capability);
    }
    if (hardware.error) return hardware.error;
    if (hardware.phase === "compiling") return "The secure compiler is building this sketch.";
    if (hardware.phase === "compiled") return "Compiled for the Nano old bootloader. Choose the board next.";
    if (hardware.phase === "connecting") return "Choose the Nano serial port in the browser prompt.";
    if (hardware.serialReading) return "Reading bounded serial output at 9600 baud…";
    if (hardware.phase === "connected") return hardware.device?.displayName ?? "Nano connected.";
    if (hardware.phase === "uploading") return "Keep the USB cable connected while Firelight writes the sketch.";
    if (hardware.phase === "success") {
      return "Upload succeeded and browser evidence was recorded for lesson completion.";
    }
    return getHardwareCapabilityGuidance(hardware.capability);
  })();

  const runHardwareAction = (action: Promise<unknown>) => {
    void action.catch(() => undefined);
  };

  return (
    <div className="lesson-workspace" data-access={workspaceAccess}>
      <div className="lesson-access-banner" role="status">
        {canRecord ? <CheckCircle2 aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
        <span>{accessMessage}</span>
        {identity.status === "anonymous" || identity.status === "error" ? (
          <Link to="/auth">Sign in</Link>
        ) : null}
        {identity.status === "authenticated" && identity.data && !identity.data.activation ? (
          <Link to="/activate">Activate kit</Link>
        ) : null}
      </div>

      <div className="lesson-workspace__grid">
        <aside className="lesson-stepper panel" aria-label={`${lesson.title} steps`}>
          <p className="eyebrow">Build steps</p>
          <ProgressBar
            label={`${lesson.title} checkpoint`}
            value={savedProgress?.status === "completed" ? 100 : checkpointPercentage}
          />
          <ol>
            {lesson.steps.map((item, index) => {
              const complete = completedStepIds.has(item.id);
              const checkpoint = index === checkpointStepIndex;
              const displayed = index === displayStepIndex;
              return (
                <li
                  key={item.id}
                  data-complete={complete}
                  data-checkpoint={checkpoint}
                  data-displayed={displayed}
                >
                  <button
                    type="button"
                    aria-controls="lesson-stage"
                    aria-current={displayed ? "step" : undefined}
                    aria-label={`${item.ariaLabel}${checkpoint ? ", saved checkpoint" : ""}`}
                    onClick={() => {
                      setDisplayStepIndex(index);
                      setValidation(null);
                      setQuizChecked(false);
                      setSelectedChoice(null);
                      if (
                        typeof window.matchMedia === "function" &&
                        window.matchMedia(NARROW_LESSON_VIEWPORT).matches
                      ) {
                        setStageFocusRequest((request) => request + 1);
                      }
                    }}
                  >
                    {complete ? <Check aria-hidden="true" /> : checkpoint ? <Circle aria-hidden="true" /> : <span>{index + 1}</span>}
                    <span>{item.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <section
          className="lesson-stage"
          id="lesson-stage"
          aria-labelledby="lesson-step-title"
        >
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {step.title}. Step {displayStepIndex + 1} of {lesson.steps.length}.
          </p>
          <header className="lesson-stage__header">
            <div>
              <p className="eyebrow">
                Step {displayStepIndex + 1} of {lesson.steps.length}
              </p>
              <h2 id="lesson-step-title" ref={stageHeadingRef} tabIndex={-1}>
                {step.title}
              </h2>
            </div>
            {displayStepIndex !== checkpointStepIndex ? (
              <span className="status-chip">Previewing · checkpoint {checkpointStepIndex + 1}</span>
            ) : null}
          </header>

          <div className="lesson-stage__body">
            <LessonStepContent
              lesson={lesson}
              step={step}
              code={code}
              canEdit={canModify}
              codeReadOnlyMessage={codeReadOnlyMessage}
              selectedChoice={selectedChoice}
              quizChecked={quizChecked}
              validation={validation}
              hardware={hardware}
              hardwareMessage={hardwareMessage}
              observationConfirmed={observedStepIds.has(step.id)}
              onCodeChange={(value) => {
                hasEditedCodeRef.current = true;
                setCode(value);
                setValidation(null);
                setObservedStepIds(new Set());
                runHardwareAction(hardwareWorkflow.invalidateCode());
                queueProgress({
                  status: "in_progress",
                  currentStep: checkpointStep.id,
                  percentage: checkpointPercentage,
                  codeSnapshot: value,
                });
              }}
              onChoiceChange={(value) => {
                setSelectedChoice(value);
                setQuizChecked(false);
              }}
              onCheckQuiz={() => {
                setQuizChecked(true);
              }}
              onValidateCode={() => {
                if (step.type === "code-validation") {
                  setValidation(validateLessonCode(step.validatorId, code));
                }
              }}
              onCompile={() => {
                runHardwareAction(
                  hardwareWorkflow.compile({
                    lessonId: lesson.id,
                    lessonVersion: lesson.version,
                    fqbn: FIRELIGHT_BOARD_FQBN,
                    source: code,
                  }),
                );
              }}
              onConnect={() => {
                runHardwareAction(hardwareWorkflow.connect());
              }}
              onUpload={() => {
                setObservedStepIds(new Set());
                runHardwareAction(hardwareWorkflow.upload());
              }}
              onReadSerial={() => {
                if (step.type === "serial-check") {
                  runHardwareAction(hardwareWorkflow.readSerial(step.baudRate));
                }
              }}
              onConfirmObservation={() => {
                setObservedStepIds((current) => new Set(current).add(step.id));
              }}
            />
          </div>

          <footer className="lesson-stage__footer">
            <button
              className="pixel-button pixel-button--secondary"
              type="button"
              disabled={displayStepIndex === 0}
              onClick={() => {
                setDisplayStepIndex((index) => Math.max(0, index - 1));
              }}
            >
              <ArrowLeft aria-hidden="true" /> Previous
            </button>
            {displayStepIndex !== checkpointStepIndex ? (
              <button
                className="pixel-button"
                type="button"
                onClick={() => {
                  setDisplayStepIndex(checkpointStepIndex);
                }}
              >
                Return to checkpoint
              </button>
            ) : (
              <button className="pixel-button" type="button" disabled={!stepCanAdvance} onClick={advance}>
                {step.type === "completion" ? "Complete lesson" : "Next step"}
                <ArrowRight aria-hidden="true" />
              </button>
            )}
          </footer>

          {canRecord ? (
            <div
              className={`autosave-status autosave-status--${autosave.status.tone}`}
              role={autosave.status.accessibility.role}
              aria-live={autosave.status.accessibility.live}
              aria-atomic={autosave.status.accessibility.atomic}
            >
              <span>{autosave.status.message}</span>
              {autosave.status.canRetry ? (
                <button type="button" onClick={() => { autosave.retry(); }}>
                  <RotateCcw aria-hidden="true" /> Retry save
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        <aside className="lesson-reference" aria-label="Build reference">
          <Panel>
            <p className="eyebrow">Hardware state</p>
            <HardwareStatus phase={hardware.phase} />
            <p id="hardware-note" className="muted-copy">
              {hardwareMessage}
            </p>
            {hardware.phase === "compiling" ||
            hardware.phase === "connecting" ||
            hardware.phase === "uploading" ||
            hardware.serialReading ? (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  runHardwareAction(hardwareWorkflow.cancel());
                }}
              >
                Cancel hardware action
              </button>
            ) : null}
            {hardware.device ? (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  runHardwareAction(hardwareWorkflow.disconnect());
                }}
              >
                Disconnect board
              </button>
            ) : null}
          </Panel>
          <Panel>
            <Wrench aria-hidden="true" />
            <p className="eyebrow">Parts and pins</p>
            <ul>
              {lesson.hardwareParts.map((part) => <li key={part}>{part}</li>)}
            </ul>
            <dl className="pin-map">
              {lesson.pinAssignments.map((assignment) => (
                <div key={`${assignment.component}-${assignment.signal}-${assignment.pin}`}>
                  <dt>{assignment.component} · {assignment.signal}</dt>
                  <dd>
                    {assignment.pin}
                    {assignment.note ? <small>{assignment.note}</small> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel className="safety-panel">
            <ShieldAlert aria-hidden="true" />
            <p className="eyebrow">Power-safe build</p>
            <ul>
              {lesson.safetyNotes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </Panel>
        </aside>
      </div>

      <section className="troubleshooting panel" aria-labelledby="troubleshooting-title">
        <p className="eyebrow">When the trail gets tangled</p>
        <h2 id="troubleshooting-title">Troubleshooting</h2>
        <div>
          {lesson.troubleshooting.map((item) => (
            <details key={item.problem}>
              <summary>{item.problem}</summary>
              <p>{item.guidance}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
