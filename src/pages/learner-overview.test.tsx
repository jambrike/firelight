import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { LessonSlug } from "../../shared/curriculum";
import type {
  Achievement,
  BootstrapData,
  LessonProgress,
  LessonProgressStatus,
} from "../../shared/identity";
import {
  anonymousIdentity,
  IdentityContext,
} from "../features/identity/identity-context";
import { lessonCatalog } from "../features/lessons/catalog";
import { CampPage } from "./CampPage";
import { LearnPage } from "./LearnPage";

const timestamp = "2026-08-07T12:00:00.000Z";

function saved(
  lessonId: LessonSlug,
  status: LessonProgressStatus,
  percentage: number,
  lessonVersion = 1,
): LessonProgress {
  return {
    lessonId,
    lessonVersion,
    revision: 1,
    status,
    currentStep: status === "completed" ? "finish-lesson" : "edit-code",
    percentage,
    codeSnapshot: null,
    completedAt: status === "completed" ? timestamp : null,
    updatedAt: timestamp,
  };
}

const staleServerAchievements: readonly Achievement[] = [
  { id: "first-upload", label: "First Upload", earned: true },
  { id: "name-signal", label: "Name Signal", earned: true },
  { id: "trail-complete", label: "Trail Complete", earned: true },
];

function bootstrap(
  progress: readonly LessonProgress[],
  overrides: Partial<Pick<BootstrapData, "activation" | "achievements" | "nextLesson">> = {},
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
    activation: {
      id: "kit-id",
      batch: "pilot",
      kind: "code",
      claimedAt: timestamp,
    },
    progress,
    achievements: [],
    nextLesson: { id: "first-spark", title: "First Spark" },
    ...overrides,
  };
}

function renderOverview(element: ReactElement, data: BootstrapData | null) {
  const location = memoryLocation({ path: data ? "/camp" : "/learn" });
  const identity = data
    ? { ...anonymousIdentity, status: "authenticated" as const, data }
    : anonymousIdentity;

  return render(
    <IdentityContext.Provider value={identity}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        {element}
      </Router>
    </IdentityContext.Provider>,
  );
}

describe("learner overview derivations", () => {
  it("keeps all lessons previewable for anonymous visitors", () => {
    const { container } = renderOverview(<LearnPage />, null);

    expect(screen.getAllByText("Preview lesson")).toHaveLength(6);
    expect(screen.queryByText(/Requires /)).not.toBeInTheDocument();
    const morseCard = container.querySelector<HTMLElement>('[data-lesson="morse-name"]');
    expect(morseCard).not.toBeNull();
    expect(within(morseCard!).getByRole("link")).toHaveAttribute(
      "href",
      "/learn/morse-name",
    );
  });

  it("ignores stale lesson versions and explains locks without disabling preview links", () => {
    const data = bootstrap([saved("first-spark", "completed", 100, 0)]);
    const { container } = renderOverview(<LearnPage />, data);

    expect(container.querySelector('[data-lesson="first-spark"]')).toHaveAttribute(
      "data-status",
      "available",
    );
    expect(container.querySelector('[data-lesson="morse-name"]')).toHaveAttribute(
      "data-status",
      "locked",
    );
    expect(screen.getByText("Requires First Spark")).toBeInTheDocument();
    const morseCard = container.querySelector<HTMLElement>('[data-lesson="morse-name"]');
    expect(morseCard).not.toBeNull();
    expect(within(morseCard!).getByRole("link")).toHaveAttribute(
      "href",
      "/learn/morse-name",
    );
  });

  it("unlocks only the next link in the prerequisite chain", () => {
    const data = bootstrap([saved("first-spark", "completed", 100)]);
    const { container } = renderOverview(<LearnPage />, data);

    expect(container.querySelector('[data-lesson="first-spark"]')).toHaveAttribute(
      "data-status",
      "completed",
    );
    expect(container.querySelector('[data-lesson="morse-name"]')).toHaveAttribute(
      "data-status",
      "available",
    );
    expect(container.querySelector('[data-lesson="button-reaction"]')).toHaveAttribute(
      "data-status",
      "locked",
    );
    expect(screen.getByText("Requires Morse Name")).toBeInTheDocument();
  });

  it("resumes current progress and derives partial totals instead of trusting server summaries", () => {
    const data = bootstrap(
      [
        saved("first-spark", "completed", 100),
        { ...saved("morse-name", "in_progress", 40), revision: 4 },
      ],
      {
        activation: null,
        achievements: staleServerAchievements,
        nextLesson: { id: "trail-rover", title: "Trail Rover" },
      },
    );
    renderOverview(<CampPage />, data);

    expect(screen.getByRole("heading", { name: "Next: Morse Name" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Resume trail" })).toHaveAttribute(
      "href",
      "/learn/morse-name",
    );
    expect(screen.getByRole("progressbar", { name: "Core trail progress" })).toHaveAttribute(
      "value",
      "23",
    );
    expect(screen.getByText("1 earned.")).toBeInTheDocument();
    expect(screen.getByText("Activation needed")).toBeInTheDocument();
  });

  it("starts a fresh learner at the first available lesson", () => {
    renderOverview(<CampPage />, bootstrap([]));

    expect(screen.getByRole("heading", { name: "Next: First Spark" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start trail" })).toHaveAttribute(
      "href",
      "/learn/first-spark",
    );
    expect(
      screen.getByText("Your next available build is ready whenever the hardware is."),
    ).toBeInTheDocument();
  });

  it("derives full completion and every achievement from current catalog versions", () => {
    const progress = lessonCatalog.map((lesson) =>
      saved(lesson.id, "completed", 100, lesson.version),
    );
    const data = bootstrap(progress, {
      achievements: [],
      nextLesson: { id: "first-spark", title: "First Spark" },
    });
    renderOverview(<CampPage />, data);

    expect(
      screen.getByRole("heading", { name: "The core trail is complete!" }),
    ).toBeInTheDocument();
    expect(screen.getByText("6 of 6 builds complete")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Core trail progress" })).toHaveAttribute(
      "value",
      "100",
    );
    expect(screen.getByText("3 earned.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review trail" })).toHaveAttribute(
      "href",
      "/learn",
    );
  });
});
