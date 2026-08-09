import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityContext, anonymousIdentity } from "../features/identity/identity-context";
import { ActivatePage } from "./ActivatePage";
import { AuthPage } from "./AuthPage";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("identity pages", () => {
  it("submits signup with a builder name, email, and password", async () => {
    const user = userEvent.setup();
    const signUp = vi.fn(async () => undefined);
    render(
      <IdentityContext.Provider value={{ ...anonymousIdentity, signUp }}>
        <AuthPage />
      </IdentityContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Create account" }));
    await user.type(screen.getByLabelText("Builder name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText(/^Password/), "robotics8");
    const form = screen.getByRole("heading", { name: "Create your builder profile" }).closest("form");
    expect(form).not.toBeNull();
    await user.click(within(form!).getByRole("button", { name: "Create account" }));

    expect(signUp).toHaveBeenCalledWith("ada@example.com", "robotics8", "Ada");
    expect(await screen.findByRole("status")).toHaveTextContent("Account created");
  });

  it("removes one-time recovery parameters after a successful password update", async () => {
    window.history.replaceState(
      null,
      "",
      "/auth?mode=reset&code=one-time-code&sb_flow_id=0123456789abcdef0123456789abcdef",
    );
    const user = userEvent.setup();
    const updatePassword = vi.fn(async () => undefined);
    render(
      <IdentityContext.Provider
        value={{
          ...anonymousIdentity,
          status: "authenticated",
          recoveryMode: true,
          data: {
            profile: {
              id: "user-id",
              displayName: "Ada",
              role: "learner",
              email: "ada@example.com",
              emailConfirmed: true,
              createdAt: "2026-08-06T00:00:00.000Z",
              updatedAt: "2026-08-06T00:00:00.000Z",
            },
            activation: null,
            progress: [],
            achievements: [],
            nextLesson: { id: "first-spark", title: "First Spark" },
          },
          updatePassword,
        }}
      >
        <AuthPage />
      </IdentityContext.Provider>,
    );

    await user.type(screen.getByLabelText(/New password/), "new-robotics-8");
    await user.click(screen.getByRole("button", { name: "Update password" }));

    expect(updatePassword).toHaveBeenCalledWith("new-robotics-8");
    expect(await screen.findByRole("heading", { name: "Welcome back, Ada." }))
      .toBeInTheDocument();
    expect(window.location.pathname).toBe("/auth");
    expect(window.location.search).toBe("");
  });

  it("formats a kit code for readability and submits it once", async () => {
    const user = userEvent.setup();
    const claimKit = vi.fn(async () => ({
      id: "kit-id",
      batch: "pilot",
      kind: "code" as const,
      claimedAt: "2026-08-06T00:00:00.000Z",
    }));
    render(
      <IdentityContext.Provider
        value={{
          ...anonymousIdentity,
          status: "authenticated",
          data: {
            profile: {
              id: "user-id",
              displayName: "Ada",
              role: "learner",
              email: "ada@example.com",
              emailConfirmed: true,
              createdAt: "2026-08-06T00:00:00.000Z",
              updatedAt: "2026-08-06T00:00:00.000Z",
            },
            activation: null,
            progress: [],
            achievements: [],
            nextLesson: { id: "first-spark", title: "First Spark" },
          },
          claimKit,
        }}
      >
        <ActivatePage />
      </IdentityContext.Provider>,
    );

    const input = screen.getByLabelText("Kit code");
    await user.type(input, "abcdefghjkmpnrst");
    expect(input).toHaveValue("ABCD-EFGH-JKMP-NRST");
    await user.click(screen.getByRole("button", { name: "Activate kit" }));

    expect(claimKit).toHaveBeenCalledWith("ABCD-EFGH-JKMP-NRST");
    expect(await screen.findByRole("status")).toHaveTextContent("Kit activated");
  });
});
