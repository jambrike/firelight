import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

afterEach(() => {
  vi.restoreAllMocks();
});

function BrokenRoute(): never {
  throw new Error("dynamic route failed");
}

function RouteHarness({ onReload }: { readonly onReload: () => void }) {
  const [route, setRoute] = useState("/kit");
  return (
    <>
      <button type="button" onClick={() => { setRoute("/learn"); }}>
        Change route
      </button>
      <RouteErrorBoundary resetKey={route} onReload={onReload}>
        {route === "/kit" ? <BrokenRoute /> : <h1>Build path recovered</h1>}
      </RouteErrorBoundary>
    </>
  );
}

describe("route error recovery", () => {
  it("keeps a safe reload and full-navigation escape visible after a route failure", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<RouteHarness onReload={onReload} />);

    expect(screen.getByRole("alert")).toHaveTextContent("This part of camp did not arrive.");
    expect(screen.getByRole("link", { name: "Return to the campfire" }))
      .toHaveAttribute("href", "/");

    await user.click(screen.getByRole("button", { name: "Reload this page" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("resets after navigation so the persistent shell can recover without a reload", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<RouteHarness onReload={() => undefined} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change route" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Build path recovered" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
