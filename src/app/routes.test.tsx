import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { IdentityContext, anonymousIdentity } from "../features/identity/identity-context";
import type { BootstrapData } from "../../shared/identity";
import { routeManifest } from "./route-manifest";
import { AppRoutes } from "./routes";

const routeCases = [
  ["/", "Build real robots, one spark at a time."],
  ["/kit", "Everything needed for the first six builds."],
  ["/auth", "Your builds should be waiting when you return."],
  ["/activate", "Match this kit to your camp."],
  ["/camp", "Welcome back, Ada."],
  ["/learn", "Where the real building lives."],
  ["/learn/first-spark", "First Spark"],
  ["/account", "One place for your profile, kit, and data."],
  ["/admin", "A small console for keeping builders moving."],
] as const;

function renderPath(path: string) {
  const location = memoryLocation({ path });
  const authenticatedData: BootstrapData = {
    profile: {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Ada",
      role: "admin",
      email: "ada@example.com",
      emailConfirmed: true,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    },
    activation: null,
    progress: [],
    achievements: [],
    nextLesson: { id: "first-spark", title: "First Spark" },
  };
  const identity =
    path === "/auth"
      ? anonymousIdentity
      : { ...anonymousIdentity, status: "authenticated" as const, data: authenticatedData };
  return render(
    <IdentityContext.Provider value={identity}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <AppRoutes />
      </Router>
    </IdentityContext.Provider>,
  );
}

describe("Firelight routes", () => {
  it("publishes every planned route in the typed manifest", () => {
    expect(routeManifest).toEqual([
      "/",
      "/kit",
      "/auth",
      "/activate",
      "/camp",
      "/learn",
      "/learn/:lesson",
      "/account",
      "/admin",
    ]);
  });

  it("shows one visible, announced loading state while a route chunk resolves", async () => {
    renderPath("/kit");

    const loadingStatus = screen.getByRole("status");
    expect(loadingStatus).toHaveTextContent("Loading this part of camp…");
    expect(loadingStatus).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByRole("status")).toHaveLength(1);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Everything needed for the first six builds.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading this part of camp…")).not.toBeInTheDocument();
  });

  it.each(routeCases)("renders %s", async (path, heading) => {
    renderPath(path);

    expect(
      await screen.findByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("renders a safe not-found page", () => {
    renderPath("/not-a-firelight-route");

    expect(
      screen.getByRole("heading", { level: 1, name: "This path ends in the woods." }),
    ).toBeInTheDocument();
  });

  it("announces client navigation, updates the title, and moves focus to main", async () => {
    const user = userEvent.setup();
    renderPath("/");

    await user.click(screen.getByRole("link", { name: "Preview the trail" }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Where the real building lives.",
      }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Learn — Firelight");
    expect(screen.getByRole("main")).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Build path loaded.");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText("Loading this part of camp…")).not.toBeInTheDocument();
  });
});
