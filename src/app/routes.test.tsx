import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { routeManifest } from "./route-manifest";
import { AppRoutes } from "./routes";

const routeCases = [
  ["/", "Build real robots, one spark at a time."],
  ["/kit", "Everything needed for the first six builds."],
  ["/auth", "Your builds should be waiting when you return."],
  ["/activate", "Match this kit to your camp."],
  ["/camp", "Your next build waits by the fire."],
  ["/learn", "Where the real building lives."],
  ["/learn/first-spark", "First Spark"],
  ["/account", "One place for your profile, kit, and data."],
  ["/admin", "A small console for keeping builders moving."],
] as const;

function renderPath(path: string) {
  const location = memoryLocation({ path });
  return render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <AppRoutes />
    </Router>,
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

  it.each(routeCases)("renders %s", (path, heading) => {
    renderPath(path);

    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
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
      screen.getByRole("heading", { level: 1, name: "Where the real building lives." }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Learn — Firelight");
    expect(screen.getByRole("main")).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Build path loaded.");
  });
});
