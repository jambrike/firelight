import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressUpdateInput } from "../../../shared/identity";
import { AccountPage } from "../../pages/AccountPage";
import { WebStorageProgressDraftPersistence } from "../progress/draft-persistence";
import { IdentityProvider } from "./IdentityProvider";
import { SessionBoundary } from "./SessionBoundary";
import { useIdentity } from "./identity-context";
import { legacyKeys } from "./legacy";

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
          void identity.deleteAccount("DELETE");
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

function OneTimeCodeProbe() {
  const identity = useIdentity();
  const [plaintextCode, setPlaintextCode] = useState("");
  return (
    <div>
      <span data-testid="refresh-status">{identity.status}</span>
      <span data-testid="refresh-token">{identity.session?.access_token ?? "none"}</span>
      <label>
        One-time plaintext code
        <input
          value={plaintextCode}
          onChange={(event) => {
            setPlaintextCode(event.currentTarget.value);
          }}
        />
      </label>
    </div>
  );
}

function IdentityStatusProbe() {
  const identity = useIdentity();
  return <span data-testid="identity-status">{identity.status}</span>;
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

function successfulConfigResponse(): Response {
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

function failedApiResponse(message: string): Response {
  return Response.json(
    {
      error: {
        code: "TEST_FAILURE",
        message,
        requestId: "test-request-id",
      },
    },
    { status: 500 },
  );
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
        return successfulConfigResponse();
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

describe("IdentityProvider legacy plaintext password purge", () => {
  it("removes only the obsolete password key while config is still unresolved", () => {
    const configResponse = deferred<Response>();
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = inputPath(input);
        requestedPaths.push(path);
        if (path === "/api/config") return configResponse.promise;
        return failedApiResponse("Unexpected protected request.");
      }),
    );
    window.localStorage.setItem(legacyKeys.plaintextPassword, "obsolete-secret");
    window.localStorage.setItem(legacyKeys.displayName, "Ada");

    const { unmount } = render(
      <IdentityProvider>
        <IdentityStatusProbe />
      </IdentityProvider>,
    );

    expect(screen.getByTestId("identity-status")).toHaveTextContent("loading");
    expect(window.localStorage.getItem(legacyKeys.plaintextPassword)).toBeNull();
    expect(window.localStorage.getItem(legacyKeys.displayName)).toBe("Ada");
    expect(requestedPaths).toEqual(["/api/config"]);
    expect(supabaseMocks.createClient).not.toHaveBeenCalled();
    expect(supabaseMocks.auth.getSession).not.toHaveBeenCalled();
    unmount();
  });

  it("removes the obsolete password for an anonymous session without a bootstrap request", async () => {
    supabaseMocks.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    window.localStorage.setItem(legacyKeys.plaintextPassword, "obsolete-secret");

    render(
      <IdentityProvider>
        <IdentityStatusProbe />
      </IdentityProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("identity-status")).toHaveTextContent("anonymous");
    });
    expect(window.localStorage.getItem(legacyKeys.plaintextPassword)).toBeNull();
    expect(
      vi.mocked(fetch).mock.calls.map(([input]) => inputPath(input)),
    ).toEqual(["/api/config"]);
  });

  it("removes the obsolete password when config loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failedApiResponse("Config unavailable.")),
    );
    window.localStorage.setItem(legacyKeys.plaintextPassword, "obsolete-secret");

    render(
      <IdentityProvider>
        <IdentityStatusProbe />
      </IdentityProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("identity-status")).toHaveTextContent("error");
    });
    expect(window.localStorage.getItem(legacyKeys.plaintextPassword)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(supabaseMocks.createClient).not.toHaveBeenCalled();
    expect(supabaseMocks.auth.getSession).not.toHaveBeenCalled();
  });

  it("removes the obsolete password when authenticated bootstrap fails", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = inputPath(input);
        requestedPaths.push(path);
        if (path === "/api/config") return successfulConfigResponse();
        if (path === "/api/bootstrap") return failedApiResponse("Bootstrap unavailable.");
        return failedApiResponse("Unexpected request.");
      }),
    );
    window.localStorage.setItem(legacyKeys.plaintextPassword, "obsolete-secret");

    render(
      <IdentityProvider>
        <IdentityStatusProbe />
      </IdentityProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("identity-status")).toHaveTextContent("error");
    });
    expect(window.localStorage.getItem(legacyKeys.plaintextPassword)).toBeNull();
    expect(requestedPaths).toEqual(["/api/config", "/api/bootstrap"]);
  });

  it("retries the purge after bootstrap when the startup storage write is rejected", async () => {
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        originalRemoveItem.call(this, key);
      });
    removeItem.mockImplementationOnce(() => {
      throw new DOMException("Storage is unavailable.", "SecurityError");
    });
    window.localStorage.setItem(legacyKeys.plaintextPassword, "obsolete-secret");

    try {
      render(
        <IdentityProvider>
          <IdentityStatusProbe />
        </IdentityProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("identity-status")).toHaveTextContent("authenticated");
      });
      expect(window.localStorage.getItem(legacyKeys.plaintextPassword)).toBeNull();
      expect(
        removeItem.mock.calls.filter(([key]) => key === legacyKeys.plaintextPassword),
      ).toHaveLength(2);
    } finally {
      removeItem.mockRestore();
    }
  });
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
  it("keeps same-owner one-time UI state mounted across an access-token refresh", async () => {
    render(
      <IdentityProvider>
        <SessionBoundary>
          <OneTimeCodeProbe />
        </SessionBoundary>
      </IdentityProvider>,
    );
    const user = userEvent.setup();
    const plaintextInput = await screen.findByRole("textbox", {
      name: "One-time plaintext code",
    });
    await user.type(plaintextInput, "ABCD-EFGH-JKMP-NRST");

    act(() => {
      supabaseMocks.authListener?.("TOKEN_REFRESHED", {
        access_token: "rotated-session-token",
        user: { id: ownerId },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("refresh-status")).toHaveTextContent("authenticated");
      expect(screen.getByTestId("refresh-token")).toHaveTextContent(
        "rotated-session-token",
      );
      expect(plaintextInput).toHaveValue("ABCD-EFGH-JKMP-NRST");
    });
  });

  it("accepts a successful exact-token mutation after a same-owner token refresh", async () => {
    const progressResponse = deferred<Response>();
    let progressAuthorization: string | null = null;
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
        if (path === "/api/lessons/first-spark/progress" && init?.method === "PUT") {
          progressAuthorization = new Headers(init.headers).get("authorization");
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
    });

    await user.click(saveButton);
    expect(progressAuthorization).toBe("Bearer session-token");
    act(() => {
      supabaseMocks.authListener?.("TOKEN_REFRESHED", {
        access_token: "rotated-session-token",
        user: { id: ownerId },
      });
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
      expect(screen.getByTestId("active-owner")).toHaveTextContent(ownerId);
      expect(screen.getByTestId("progress-code")).toHaveTextContent(
        "account-a secret code",
      );
    });
  });

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

  it("discards an account A export resolved after account B is active and the page unmounts", async () => {
    const accountExportResponse = deferred<Response>();
    const accountBBootstrap = deferred<Response>();
    let exportAuthorization: string | null = null;
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
        if (path === "/api/account/export") {
          exportAuthorization = new Headers(init?.headers).get("authorization");
          return accountExportResponse.promise;
        }
        return Response.json({ error: "Unexpected request" }, { status: 500 });
      }),
    );

    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const createObjectUrl = vi.fn(() => "blob:must-not-exist");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      render(
        <IdentityProvider>
          <SessionBoundary>
            <AccountPage />
          </SessionBoundary>
        </IdentityProvider>,
      );
      const user = userEvent.setup();
      const exportButton = await screen.findByRole("button", {
        name: "Export complete JSON",
      });
      await user.click(exportButton);
      expect(exportAuthorization).toBe("Bearer session-token");

      act(() => {
        supabaseMocks.authListener?.("SIGNED_IN", {
          access_token: "account-b-token",
          user: { id: otherOwnerId },
        });
      });
      accountBBootstrap.resolve(
        Response.json({
          data: {
            profile: {
              id: otherOwnerId,
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
      await screen.findByText("b@example.com");

      accountExportResponse.resolve(
        Response.json({
          data: {
            schema: "firelight.account-export",
            version: 2,
            exportedAt: timestamp,
            data: {
              profile: {
                id: ownerId,
                displayName: "Account A",
                role: "learner",
                email: "a-private@example.com",
                emailConfirmed: true,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              activation: null,
              progress: [],
              compileJobs: [],
              uploadEvidence: [],
            },
          },
        }),
      );
      await act(async () => {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0);
        });
      });

      expect(screen.getByText("b@example.com")).toBeInTheDocument();
      expect(createObjectUrl).not.toHaveBeenCalled();
      expect(anchorClick).not.toHaveBeenCalled();
      expect(screen.queryByText("a-private@example.com")).not.toBeInTheDocument();
    } finally {
      anchorClick.mockRestore();
      if (createObjectUrlDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
    }
  });
});
