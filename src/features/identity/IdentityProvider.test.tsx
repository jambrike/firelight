import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressUpdateInput } from "../../../shared/identity";
import { WebStorageProgressDraftPersistence } from "../progress/draft-persistence";
import { IdentityProvider } from "./IdentityProvider";
import { useIdentity } from "./identity-context";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherOwnerId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-08-07T14:00:00.000Z";

interface TestSession {
  readonly access_token: string;
  readonly user: { readonly id: string };
}

type TestAuthListener = (event: string, session: TestSession | null) => void;

const supabaseMocks = vi.hoisted(() => {
  const auth = {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  };
  return {
    auth,
    authListener: null as TestAuthListener | null,
    createClient: vi.fn(() => ({ auth })),
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: supabaseMocks.createClient,
}));

function DeleteProbe() {
  const identity = useIdentity();
  return (
    <div>
      <span>{identity.status}</span>
      <button
        type="button"
        disabled={identity.status !== "authenticated"}
        onClick={() => {
          void identity.deleteAccount();
        }}
      >
        Delete test account
      </button>
    </div>
  );
}

function ProgressProbe() {
  const identity = useIdentity();
  const progress = identity.data?.progress.find(
    (item) => item.lessonId === "first-spark",
  );
  return (
    <div>
      <span data-testid="active-owner">{identity.data?.profile.id ?? "none"}</span>
      <span data-testid="progress-code">{progress?.codeSnapshot ?? "none"}</span>
      <button
        type="button"
        disabled={identity.status !== "authenticated"}
        onClick={() => {
          const input: ProgressUpdateInput = {
            lessonVersion: 1,
            expectedRevision: null,
            status: "in_progress",
            currentStep: "edit-code",
            percentage: 20,
            codeSnapshot: "account-a secret code",
          };
          void identity.saveProgress("first-spark", input).catch(() => undefined);
        }}
      >
        Save test progress
      </button>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function inputPath(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  supabaseMocks.authListener = null;
  supabaseMocks.auth.onAuthStateChange.mockImplementation(
    (listener: TestAuthListener) => {
      supabaseMocks.authListener = listener;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
  );
  supabaseMocks.auth.getSession.mockResolvedValue({
    data: {
      session: {
        access_token: "session-token",
        user: { id: ownerId },
      },
    },
    error: null,
  });
  supabaseMocks.auth.signOut.mockResolvedValue({ error: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = inputPath(input);
      if (path === "/api/config") {
        return Response.json({
          data: {
            apiVersion: "v1",
            environment: "test",
            buildId: "test-build",
            supabase: {
              url: "https://example.supabase.co",
              publishableKey: "publishable-key",
            },
            hardware: {
              fqbn: "arduino:avr:nano:cpu=atmega328old",
              uploadBaud: 57_600,
            },
          },
        });
      }
      if (path === "/api/bootstrap") {
        return Response.json({
          data: {
            profile: {
              id: ownerId,
              displayName: "Ada",
              role: "learner",
              email: "ada@example.com",
              emailConfirmed: true,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            activation: null,
            progress: [],
            achievements: [],
            nextLesson: null,
          },
        });
      }
      if (path === "/api/account" && init?.method === "DELETE") {
        return Response.json({ data: { deleted: true } });
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 });
    }),
  );
});

describe("IdentityProvider account deletion", () => {
  it("purges only the deleted user's durable lesson drafts before local sign-out", async () => {
    const persistence = new WebStorageProgressDraftPersistence(window.localStorage);
    const ownScope = {
      ownerId,
      lessonId: "first-spark",
      lessonVersion: 1,
    } as const;
    const otherScope = {
      ...ownScope,
      ownerId: otherOwnerId,
    };
    const draft = {
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 30,
    } as const;
    persistence.save(ownScope, draft);
    persistence.save(otherScope, draft);
    render(
      <IdentityProvider>
        <DeleteProbe />
      </IdentityProvider>,
    );
    const user = userEvent.setup();
    const deleteButton = await screen.findByRole("button", {
      name: "Delete test account",
    });
    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });

    await user.click(deleteButton);

    await waitFor(() => {
      expect(supabaseMocks.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
      expect(screen.getByText("anonymous")).toBeInTheDocument();
    });
    expect(persistence.load(ownScope)).toBeNull();
    expect(persistence.load(otherScope)).toEqual(draft);
  });
});

describe("IdentityProvider mutation ownership", () => {
  it("ignores an account A progress response after account B becomes active", async () => {
    const accountBId = otherOwnerId;
    const progressResponse = deferred<Response>();
    const accountBBootstrap = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = inputPath(input);
        if (path === "/api/config") {
          return Response.json({
            data: {
              apiVersion: "v1",
              environment: "test",
              buildId: "test-build",
              supabase: {
                url: "https://example.supabase.co",
                publishableKey: "publishable-key",
              },
              hardware: {
                fqbn: "arduino:avr:nano:cpu=atmega328old",
                uploadBaud: 57_600,
              },
            },
          });
        }
        if (path === "/api/bootstrap") {
          const authorization = new Headers(init?.headers).get("authorization");
          if (authorization === "Bearer account-b-token") {
            return accountBBootstrap.promise;
          }
          return Response.json({
            data: {
              profile: {
                id: ownerId,
                displayName: "Account A",
                role: "learner",
                email: "a@example.com",
                emailConfirmed: true,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              activation: null,
              progress: [],
              achievements: [],
              nextLesson: null,
            },
          });
        }
        if (
          path === "/api/lessons/first-spark/progress" &&
          init?.method === "PUT"
        ) {
          return progressResponse.promise;
        }
        return Response.json({ error: "Unexpected request" }, { status: 500 });
      }),
    );
    render(
      <IdentityProvider>
        <ProgressProbe />
      </IdentityProvider>,
    );
    const user = userEvent.setup();
    const saveButton = await screen.findByRole("button", {
      name: "Save test progress",
    });
    await waitFor(() => {
      expect(saveButton).toBeEnabled();
      expect(screen.getByTestId("active-owner")).toHaveTextContent(ownerId);
    });

    await user.click(saveButton);
    expect(supabaseMocks.authListener).not.toBeNull();
    act(() => {
      supabaseMocks.authListener?.("SIGNED_IN", {
        access_token: "account-b-token",
        user: { id: accountBId },
      });
    });
    expect(screen.getByTestId("active-owner")).toHaveTextContent("none");
    expect(screen.getByTestId("progress-code")).toHaveTextContent("none");
    accountBBootstrap.resolve(
      Response.json({
        data: {
          profile: {
            id: accountBId,
            displayName: "Account B",
            role: "learner",
            email: "b@example.com",
            emailConfirmed: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          activation: null,
          progress: [],
          achievements: [],
          nextLesson: null,
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-owner")).toHaveTextContent(accountBId);
    });

    progressResponse.resolve(
      Response.json({
        data: {
          lessonId: "first-spark",
          lessonVersion: 1,
          revision: 1,
          status: "in_progress",
          currentStep: "edit-code",
          percentage: 20,
          codeSnapshot: "account-a secret code",
          completedAt: null,
          updatedAt: timestamp,
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-owner")).toHaveTextContent(accountBId);
      expect(screen.getByTestId("progress-code")).toHaveTextContent("none");
    });
  });
});
