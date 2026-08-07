import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { LessonSlug } from "../../../shared/curriculum";
import type {
  BootstrapData,
  LessonProgress,
  LessonProgressStatus,
  ProgressUpdateInput,
} from "../../../shared/identity";
import { LessonPage } from "../../pages/LessonPage";
import {
  anonymousIdentity,
  IdentityContext,
} from "../identity/identity-context";
import type { IdentityContextValue } from "../identity/identity-context";
import { findLesson } from "./catalog";

const timestamp = "2026-08-07T14:00:00.000Z";

function progressRecord(
  lessonId: LessonSlug,
  currentStep: string,
  options: {
    readonly status?: LessonProgressStatus;
    readonly percentage?: number;
    readonly revision?: number;
    readonly codeSnapshot?: string | null;
    readonly lessonVersion?: number;
  } = {},
): LessonProgress {
  const status = options.status ?? "in_progress";
  return {
    lessonId,
    lessonVersion: options.lessonVersion ?? 1,
    revision: options.revision ?? 1,
    status,
    currentStep,
    percentage: options.percentage ?? (status === "completed" ? 100 : 20),
    codeSnapshot: options.codeSnapshot ?? null,
    completedAt: status === "completed" ? timestamp : null,
    updatedAt: timestamp,
  };
}

function bootstrap(
  progress: readonly LessonProgress[] = [],
  activated = true,
): BootstrapData {
  return {
    profile: {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Ada",
      role: "learner",
      email: "ada@example.com",
      emailConfirmed: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    activation: activated
      ? { id: "kit-id", batch: "pilot", kind: "code", claimedAt: timestamp }
      : null,
    progress,
    achievements: [],
    nextLesson: { id: "first-spark", title: "First Spark" },
  };
}

function savedFromInput(
  lessonId: LessonSlug,
  input: ProgressUpdateInput,
  revision: number,
): LessonProgress {
  return {
    lessonId,
    lessonVersion: input.lessonVersion,
    revision,
    status: input.status,
    currentStep: input.currentStep,
    percentage: input.percentage,
    codeSnapshot: input.codeSnapshot ?? null,
    completedAt: input.status === "completed" ? timestamp : null,
    updatedAt: timestamp,
  };
}

function authenticatedIdentity(
  data: BootstrapData,
  saveProgress: IdentityContextValue["saveProgress"] = async (lessonId, input) =>
    savedFromInput(lessonId, input, (input.expectedRevision ?? 0) + 1),
): IdentityContextValue {
  return {
    ...anonymousIdentity,
    status: "authenticated",
    data,
    saveProgress,
    refresh: async () => data,
  };
}

function renderLesson(
  lessonId: LessonSlug,
  identity: IdentityContextValue = anonymousIdentity,
): ReturnType<typeof render> {
  const location = memoryLocation({ path: `/learn/${lessonId}` });
  const element: ReactElement = (
    <IdentityContext.Provider value={identity}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Route path="/learn/:lesson">
          <LessonPage />
        </Route>
      </Router>
    </IdentityContext.Provider>
  );
  return render(element);
}

function stepButton(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name });
}

describe("lesson workspace integration", () => {
  it("allows anonymous preview navigation while gating editing and advancement", async () => {
    const user = userEvent.setup();
    const { container } = renderLesson("first-spark");

    expect(container.querySelector(".lesson-workspace")).toHaveAttribute(
      "data-access",
      "preview",
    );
    expect(screen.getByText("Preview mode · sign in to edit and save")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth");
    expect(screen.getByRole("button", { name: "Next step" })).toBeDisabled();

    await user.click(stepButton("Edit the Arduino sketch"));
    expect(screen.getByLabelText("Arduino sketch")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Arduino sketch")).toBeEnabled();
    expect(screen.getByText("Shape the sketch. Step 3 of 10.")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    await user.click(stepButton("Compile the validated Arduino sketch"));
    expect(screen.getByRole("button", { name: "Compile sketch" })).toBeDisabled();
  });

  it("shows an activation CTA to an authenticated learner without a claimed kit", async () => {
    const user = userEvent.setup();
    const identity = authenticatedIdentity(bootstrap([], false));
    const { container } = renderLesson("first-spark", identity);

    expect(container.querySelector(".lesson-workspace")).toHaveAttribute(
      "data-access",
      "preview",
    );
    expect(
      screen.getByText("Preview mode · activate a kit to edit and save"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Activate kit" })).toHaveAttribute(
      "href",
      "/activate",
    );

    await user.click(stepButton("Edit the Arduino sketch"));
    expect(screen.getByLabelText("Arduino sketch")).toHaveAttribute("readonly");
  });

  it("keeps an activated learner in preview until prerequisites are complete", async () => {
    const user = userEvent.setup();
    const identity = authenticatedIdentity(bootstrap());
    const { container } = renderLesson("morse-name", identity);

    expect(container.querySelector(".lesson-workspace")).toHaveAttribute(
      "data-access",
      "preview",
    );
    expect(screen.getByText("Preview mode · complete First Spark first")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Activate kit" })).not.toBeInTheDocument();

    await user.click(stepButton("Edit the Arduino sketch"));
    expect(screen.getByLabelText("Arduino sketch")).toHaveAttribute("readonly");
  });

  it("resumes the current step and code snapshot with accessible controls", () => {
    const snapshot = "// resumed on another device\nvoid setup() {}\nvoid loop() {}\n";
    const saved = progressRecord("first-spark", "edit-code", {
      percentage: 18,
      revision: 7,
      codeSnapshot: snapshot,
    });
    const identity = authenticatedIdentity(bootstrap([saved]));
    renderLesson("first-spark", identity);

    expect(screen.getByRole("list", { name: "Lesson details" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "First Spark steps" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shape the sketch" })).toBeInTheDocument();
    expect(screen.getByLabelText("Arduino sketch")).toHaveValue(snapshot);
    expect(screen.getByLabelText("Arduino sketch")).toBeEnabled();
    expect(stepButton(/Edit the Arduino sketch, saved checkpoint/)).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByRole("progressbar", { name: "First Spark checkpoint" })).toHaveAttribute(
      "value",
      "18",
    );
  });

  it("hydrates a saved checkpoint that arrives after the public preview mounts", () => {
    const location = memoryLocation({ path: "/learn/first-spark" });
    const renderTree = (identity: IdentityContextValue): ReactElement => (
      <IdentityContext.Provider value={identity}>
        <Router hook={location.hook} searchHook={location.searchHook}>
          <Route path="/learn/:lesson">
            <LessonPage />
          </Route>
        </Router>
      </IdentityContext.Provider>
    );
    const loadingIdentity: IdentityContextValue = {
      ...anonymousIdentity,
      status: "loading",
    };
    const view = render(renderTree(loadingIdentity));
    expect(screen.getByRole("heading", { name: "Meet the build" })).toBeInTheDocument();

    const snapshot = "// loaded after session bootstrap\nvoid setup() {}\nvoid loop() {}\n";
    const saved = progressRecord("first-spark", "edit-code", {
      percentage: 18,
      revision: 7,
      codeSnapshot: snapshot,
    });
    view.rerender(renderTree(authenticatedIdentity(bootstrap([saved]))));

    expect(screen.getByRole("heading", { name: "Shape the sketch" })).toBeInTheDocument();
    expect(screen.getByLabelText("Arduino sketch")).toHaveValue(snapshot);
    expect(screen.getByRole("progressbar", { name: "First Spark checkpoint" })).toHaveAttribute(
      "value",
      "18",
    );
  });

  it("keeps a completed lesson in read-only review mode", async () => {
    const user = userEvent.setup();
    const saved = progressRecord("first-spark", "finish-lesson", {
      status: "completed",
      percentage: 100,
      revision: 9,
      codeSnapshot: "// completed sketch",
    });
    const identity = authenticatedIdentity(bootstrap([saved]));
    const { container } = renderLesson("first-spark", identity);

    expect(container.querySelector(".lesson-workspace")).toHaveAttribute(
      "data-access",
      "review",
    );
    expect(screen.getByText("Review mode · this lesson is complete")).toBeInTheDocument();
    await user.click(stepButton("Edit the Arduino sketch"));
    expect(screen.getByLabelText("Arduino sketch")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Arduino sketch")).toBeEnabled();
    expect(
      screen.getByText(
        "This completed sketch is read-only. You can focus and copy it while reviewing.",
      ),
    ).toBeInTheDocument();
  });

  it("locks the workspace when completion is queued while keeping failed autosave retryable", async () => {
    vi.useFakeTimers();
    const saved = progressRecord("first-spark", "finish-lesson", {
      percentage: 90,
      revision: 8,
      codeSnapshot: "// ready to finish",
    });
    const saveProgress = vi
      .fn(
        async (lessonId: LessonSlug, input: ProgressUpdateInput) =>
          savedFromInput(lessonId, input, 9),
      )
      .mockRejectedValueOnce(new Error("Save interrupted."));
    const identity = authenticatedIdentity(bootstrap([saved]), saveProgress);
    const view = renderLesson("first-spark", identity);

    try {
      fireEvent.click(screen.getByRole("button", { name: "Complete lesson" }));

      expect(view.container.querySelector(".lesson-workspace")).toHaveAttribute(
        "data-access",
        "review",
      );
      expect(screen.getByRole("button", { name: "Complete lesson" })).toBeDisabled();
      fireEvent.click(stepButton("Edit the Arduino sketch"));
      const editor = screen.getByLabelText("Arduino sketch");
      expect(editor).toHaveAttribute("readonly");
      fireEvent.change(editor, { target: { value: "// must not regress completion" } });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(saveProgress).toHaveBeenCalledOnce();
      expect(saveProgress).toHaveBeenLastCalledWith("first-spark", {
        lessonVersion: 1,
        expectedRevision: 8,
        status: "completed",
        currentStep: "finish-lesson",
        percentage: 100,
        codeSnapshot: "// ready to finish",
      });
      expect(screen.getByRole("button", { name: "Retry save" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(saveProgress).toHaveBeenCalledTimes(2);
      expect(view.container.querySelector(".lesson-workspace")).toHaveAttribute(
        "data-access",
        "review",
      );
    } finally {
      view.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not treat an authenticated identity without bootstrap data as activated", () => {
    const saveProgress = vi.fn(authenticatedIdentity(bootstrap()).saveProgress);
    const identity: IdentityContextValue = {
      ...anonymousIdentity,
      status: "authenticated",
      data: null,
      saveProgress,
    };
    const { container } = renderLesson("first-spark", identity);

    expect(container.querySelector(".lesson-workspace")).toHaveAttribute(
      "data-access",
      "preview",
    );
    expect(screen.getByText("Checking your camp access…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next step" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Activate kit" })).not.toBeInTheDocument();
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it("keeps the next step gated until code validation succeeds", async () => {
    const user = userEvent.setup();
    const lesson = findLesson("first-spark");
    expect(lesson).toBeDefined();
    if (!lesson) return;
    const saved = progressRecord("first-spark", "validate-code", {
      percentage: 27,
      revision: 3,
      codeSnapshot: "void setup() {}\nvoid loop() {}",
    });
    const identity = authenticatedIdentity(bootstrap([saved]));
    renderLesson("first-spark", identity);

    const next = screen.getByRole("button", { name: "Next step" });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check my code" }));
    expect(screen.getByText(/things to revisit/)).toBeInTheDocument();
    expect(next).toBeDisabled();

    await user.click(stepButton("Edit the Arduino sketch"));
    fireEvent.change(screen.getByLabelText("Arduino sketch"), {
      target: { value: lesson.starterCode },
    });
    await user.click(screen.getByRole("button", { name: "Return to checkpoint" }));
    await user.click(screen.getByRole("button", { name: "Check my code" }));

    expect(
      screen.getByText("The LED output and safe matching delays are ready to compile."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next step" })).toBeEnabled();
  });

  it("debounces code saves and sends the persisted revision through identity context", async () => {
    vi.useFakeTimers();
    const snapshot = "// before edit\nvoid setup() {}\nvoid loop() {}";
    const edited = `${snapshot}\n// local edit`;
    const saved = progressRecord("first-spark", "edit-code", {
      percentage: 18,
      revision: 7,
      codeSnapshot: snapshot,
    });
    const saveProgress = vi.fn(
      async (lessonId: LessonSlug, input: ProgressUpdateInput) =>
        savedFromInput(lessonId, input, 8),
    );
    const identity = authenticatedIdentity(bootstrap([saved]), saveProgress);
    const view = renderLesson("first-spark", identity);

    try {
      fireEvent.change(screen.getByLabelText("Arduino sketch"), {
        target: { value: edited },
      });

      await act(async () => {
        vi.advanceTimersByTime(799);
        await Promise.resolve();
      });
      expect(saveProgress).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(saveProgress).toHaveBeenCalledTimes(1);
      expect(saveProgress).toHaveBeenCalledWith("first-spark", {
        lessonVersion: 1,
        expectedRevision: 7,
        status: "in_progress",
        currentStep: "edit-code",
        percentage: 18,
        codeSnapshot: edited,
      });
    } finally {
      view.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("announces the deferred browser requirement beside disabled hardware actions", async () => {
    const secureContextDescriptor = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    const serialDescriptor = Object.getOwnPropertyDescriptor(navigator, "serial");
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Reflect.deleteProperty(navigator, "serial");
    const user = userEvent.setup();
    const view = renderLesson("first-spark");

    try {
      await user.click(stepButton("Compile the validated Arduino sketch"));
      expect(screen.getByRole("button", { name: "Compile sketch" })).toBeDisabled();
      expect(
        screen.getAllByText(
          "Use desktop Chrome or Edge with Web Serial enabled for hardware steps.",
        ).length,
      ).toBeGreaterThanOrEqual(1);
      const reference = screen.getByRole("complementary", { name: "Build reference" });
      expect(
        within(reference).getByText(
          "Use desktop Chrome or Edge with Web Serial enabled for hardware steps.",
        ),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      if (secureContextDescriptor) {
        Object.defineProperty(window, "isSecureContext", secureContextDescriptor);
      } else {
        Reflect.deleteProperty(window, "isSecureContext");
      }
      if (serialDescriptor) {
        Object.defineProperty(navigator, "serial", serialDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "serial");
      }
    }
  });
});
