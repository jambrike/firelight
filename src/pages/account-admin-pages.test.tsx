import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import {
  ACCOUNT_EXPORT_SCHEMA,
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  type AccountExport,
} from "../../shared/account-export";
import type { BootstrapData } from "../../shared/identity";
import { IdentityContext, anonymousIdentity } from "../features/identity/identity-context";
import { AccountPage } from "./AccountPage";
import { AdminPage } from "./AdminPage";

const timestamp = "2026-08-08T10:00:00.000Z";
const ownerId = "11111111-1111-4111-8111-111111111111";
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

const accountData: BootstrapData = {
  profile: {
    id: ownerId,
    displayName: "Ada",
    role: "learner",
    email: "ada@example.com",
    emailConfirmed: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  activation: {
    id: "22222222-2222-4222-8222-222222222222",
    batch: "pilot-august",
    kind: "code",
    claimedAt: timestamp,
  },
  progress: [],
  achievements: [{ id: "first-upload", label: "First Upload", earned: false }],
  nextLesson: { id: "first-spark", title: "First Spark" },
};

const accountSession = {
  access_token: "learner-token",
  user: { id: ownerId },
} as Session;

function accountExport(profileId = ownerId): AccountExport {
  return {
    schema: ACCOUNT_EXPORT_SCHEMA,
    version: ACCOUNT_EXPORT_SCHEMA_VERSION,
    exportedAt: timestamp,
    data: {
      profile: {
        ...accountData.profile,
        id: profileId,
        displayName: "Ada Lovelace",
      },
      activation: accountData.activation,
      progress: [
        {
          lessonId: "first-spark",
          lessonVersion: 1,
          revision: 2,
          status: "completed",
          currentStep: "complete",
          percentage: 100,
          codeSnapshot: "void setup() {}",
          completionEvidenceId: "77777777-7777-4777-8777-777777777777",
          completedAt: timestamp,
          updatedAt: timestamp,
        },
        {
          lessonId: "first-spark",
          lessonVersion: 2,
          revision: 1,
          status: "in_progress",
          currentStep: "write-code",
          percentage: 40,
          codeSnapshot: null,
          completionEvidenceId: null,
          completedAt: null,
          updatedAt: timestamp,
        },
      ],
      compileJobs: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          lessonId: "first-spark",
          lessonVersion: 1,
          boardTarget: "arduino:avr:nano:cpu=atmega328old",
          sourceHash: "a".repeat(64),
          state: "succeeded",
          durationMs: 812,
          safeErrorCode: null,
          artifactHash: "b".repeat(64),
          diagnosticSummary: "Compile completed.",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp,
        },
      ],
      uploadEvidence: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          compileJobId: "66666666-6666-4666-8666-666666666666",
          lessonId: "first-spark",
          lessonVersion: 1,
          sourceHash: "a".repeat(64),
          artifactHash: "b".repeat(64),
          bytesWritten: 256,
          recordedAt: timestamp,
          attestation: "browser-web-serial-v1",
        },
      ],
    },
  };
}

let blobParts: unknown[][];

function requestPath(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function jsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON string request body.");
  return JSON.parse(init.body) as unknown;
}

beforeEach(() => {
  blobParts = [];
  function TestBlob(parts: unknown[]) {
    blobParts.push(parts);
  }
  vi.stubGlobal("Blob", TestBlob);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:firelight-test"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: originalCreateObjectUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: originalRevokeObjectUrl,
  });
  window.localStorage.clear();
});

describe("account data and deletion", () => {
  it("shows full activation details and downloads the complete server export", async () => {
    const user = userEvent.setup();
    const getAccountExport = vi.fn(async () => accountExport());
    render(
      <IdentityContext.Provider
        value={{
          ...anonymousIdentity,
          status: "authenticated",
          session: accountSession,
          data: accountData,
          getAccountExport,
        }}
      >
        <AccountPage />
      </IdentityContext.Provider>,
    );

    const kitPanel = screen.getByRole("heading", { name: "Connected kit" }).closest("section");
    expect(kitPanel).not.toBeNull();
    expect(within(kitPanel!).getByText("Claimed kit code")).toBeInTheDocument();
    expect(within(kitPanel!).getByText("pilot-august")).toBeInTheDocument();
    expect(
      within(kitPanel!).getByText("22222222-2222-4222-8222-222222222222"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export complete JSON" }));

    await waitFor(() => {
      expect(getAccountExport).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent("Complete account data downloaded");
    });
    expect(blobParts).toHaveLength(1);
    const payload = JSON.parse(String(blobParts[0]?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      schema: "firelight.account-export",
      version: 2,
      data: {
        profile: { id: ownerId, displayName: "Ada Lovelace" },
        progress: [{ lessonVersion: 1 }, { lessonVersion: 2 }],
        compileJobs: [{ id: "66666666-6666-4666-8666-666666666666" }],
        uploadEvidence: [{ id: "77777777-7777-4777-8777-777777777777" }],
      },
    });
    expect(payload.exportedAt).toBe(timestamp);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });

  it("refuses to export after an account switch and sends exact deletion confirmation", async () => {
    const user = userEvent.setup();
    const getAccountExport = vi.fn(
      async () => accountExport("33333333-3333-4333-8333-333333333333"),
    );
    const deleteAccount = vi.fn(async (confirmation: "DELETE") => {
      expect(confirmation).toBe("DELETE");
    });
    render(
      <IdentityContext.Provider
        value={{
          ...anonymousIdentity,
          status: "authenticated",
          session: accountSession,
          data: accountData,
          getAccountExport,
          deleteAccount,
        }}
      >
        <AccountPage />
      </IdentityContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Export complete JSON" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your account changed");
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();

    const dangerPanel = screen
      .getByRole("heading", { name: "Permanently delete account" })
      .closest("section");
    expect(dangerPanel).not.toBeNull();
    expect(within(dangerPanel!).getByText(/compile diagnostics and browser-upload evidence/i)).toBeInTheDocument();
    expect(within(dangerPanel!).getByText(/kit code is revoked and cannot be reused/i)).toBeInTheDocument();
    expect(within(dangerPanel!).getByText(/sign out and sign back in immediately/i)).toBeInTheDocument();

    const deleteButton = within(dangerPanel!).getByRole("button", {
      name: "Permanently delete my account",
    });
    expect(deleteButton).toBeDisabled();
    await user.type(within(dangerPanel!).getByLabelText("Type DELETE exactly to confirm"), "DELETE");
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);
    expect(deleteAccount).toHaveBeenCalledWith("DELETE");
  });
});

interface RecordedRequest {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

function adminIdentity() {
  return {
    ...anonymousIdentity,
    status: "authenticated" as const,
    session: {
      access_token: "admin-token",
      user: { id: ownerId },
    } as Session,
    data: {
      ...accountData,
      profile: { ...accountData.profile, role: "admin" as const },
    },
  };
}

function installAdminApi(): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      requests.push({ path, init });
      if (path.startsWith("/api/admin/kits/batches") && init?.method === "POST") {
        return Response.json({
          data: {
            batch: "autumn-pilot",
            codes: [
              {
                id: "55555555-5555-4555-8555-555555555555",
                code: "ABCD-EFGH-JKMP-NRST",
              },
              {
                id: "66666666-6666-4666-8666-666666666666",
                code: "WXYZ-2345-6789-BCDF",
              },
            ],
            generatedAt: timestamp,
          },
        });
      }
      if (path.includes("/revoke") && init?.method === "POST") {
        return Response.json({
          data: {
            id: "44444444-4444-4444-8444-444444444444",
            state: "revoked",
            accessRevoked: true,
          },
        });
      }
      if (path.startsWith("/api/admin/kits")) {
        return Response.json({
          data: {
            items: [{
              id: "44444444-4444-4444-8444-444444444444",
              batch: "pilot-a",
              state: "claimed",
              claimedBy: ownerId,
              claimedAt: timestamp,
              revokedAt: null,
              createdAt: timestamp,
            }],
            limit: 20,
            offset: 0,
            nextOffset: null,
          },
        });
      }
      if (path.includes(`/api/admin/learners/${ownerId}/progress`)) {
        return Response.json({
          data: {
            learner: {
              id: ownerId,
              email: "ada@example.com",
              displayName: "Ada",
              role: "learner",
              accessSource: "code",
              activationBatch: "pilot-a",
              completedLessons: 1,
              progressRecords: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            progress: {
              items: [{
                lessonId: "first-spark",
                lessonVersion: 1,
                status: "completed",
                currentStep: "finish",
                percentage: 100,
                completedAt: timestamp,
                updatedAt: timestamp,
              }],
              limit: 20,
              offset: 0,
              nextOffset: null,
            },
          },
        });
      }
      if (path.startsWith("/api/admin/learners")) {
        return Response.json({
          data: {
            items: [{
              id: ownerId,
              email: "ada@example.com",
              displayName: "Ada",
              role: "learner",
              accessSource: "code",
              activationBatch: "pilot-a",
              completedLessons: 1,
              progressRecords: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            }],
            limit: 20,
            offset: 0,
            nextOffset: null,
          },
        });
      }
      if (path.startsWith("/api/admin/compile-diagnostics")) {
        return Response.json({
          data: {
            items: [{
              id: "55555555-5555-4555-8555-555555555555",
              userId: ownerId,
              lessonId: "first-spark",
              lessonVersion: 1,
              state: "failed",
              durationMs: 210,
              safeErrorCode: "COMPILE_FAILED",
              diagnosticSummary: "Expected a semicolon near line 8.",
              createdAt: timestamp,
              finishedAt: timestamp,
            }],
            limit: 20,
            offset: 0,
            nextOffset: null,
          },
        });
      }
      if (path.startsWith("/api/admin/audit")) {
        return Response.json({
          data: {
            items: [{
              id: 7,
              actorId: ownerId,
              action: "kit.batch_created",
              targetType: "kit_batch",
              targetId: "pilot-a",
              metadata: { count: 10 },
              createdAt: timestamp,
            }],
            limit: 20,
            offset: 0,
            nextOffset: null,
          },
        });
      }
      return Response.json({ error: { code: "NOT_FOUND", message: "Missing", requestId: "test" } }, { status: 404 });
    }),
  );
  return requests;
}

describe("admin support console", () => {
  it("keeps generated plaintext transient and revokes with an explicit reason", async () => {
    const requests = installAdminApi();
    const user = userEvent.setup();
    render(
      <IdentityContext.Provider value={adminIdentity()}>
        <AdminPage />
      </IdentityContext.Provider>,
    );

    expect(await screen.findByText("pilot-a")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Batch name"), "autumn-pilot");
    const count = screen.getByLabelText("Number of codes");
    await user.clear(count);
    await user.type(count, "2");
    await user.click(screen.getByRole("button", { name: "Generate one-time codes" }));

    expect(await screen.findByText("ABCD-EFGH-JKMP-NRST")).toBeInTheDocument();
    const createRequest = requests.find((request) => request.path === "/api/admin/kits/batches");
    expect(jsonRequestBody(createRequest?.init)).toEqual({
      batch: "autumn-pilot",
      count: 2,
    });
    expect(JSON.stringify(window.localStorage)).not.toContain("ABCD-EFGH-JKMP-NRST");
    expect(screen.getAllByText(/Kit ID/)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Export code-reference pairs" }));
    expect(String(blobParts.at(-1)?.[0])).toContain("WXYZ-2345-6789-BCDF");
    expect(String(blobParts.at(-1)?.[0])).toContain("66666666-6666-4666-8666-666666666666");
    await user.click(screen.getByRole("button", { name: "Clear plaintext codes" }));
    expect(screen.queryByText("ABCD-EFGH-JKMP-NRST")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoke pilot-a kit" }));
    await user.selectOptions(screen.getByLabelText("Revocation reason"), "security");
    const confirmButton = screen.getByRole("button", { name: "Confirm revocation" });
    expect(confirmButton).toBeDisabled();
    await user.type(
      screen.getByLabelText("Type REVOKE exactly to confirm the selected reason"),
      "REVOKE",
    );
    await user.click(confirmButton);

    await waitFor(() => {
      const revokeRequest = requests.find((request) => request.path.includes("/revoke"));
      expect(jsonRequestBody(revokeRequest?.init)).toEqual({ reason: "security" });
      expect(screen.getByRole("status")).toHaveTextContent("learner's activation access removed");
    });
  });

  it("searches learners and exposes only bounded compile and audit summaries", async () => {
    const requests = installAdminApi();
    const user = userEvent.setup();
    render(
      <IdentityContext.Provider value={adminIdentity()}>
        <AdminPage />
      </IdentityContext.Provider>,
    );

    expect(await screen.findByText("Expected a semicolon near line 8.")).toBeInTheDocument();
    const learnerSearch = screen.getByLabelText("Search email, display name, or learner ID");
    await user.type(learnerSearch, "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Search learners" }));
    await user.click(await screen.findByRole("button", { name: "Inspect Ada's progress" }));
    const progressView = await screen.findByLabelText("Selected learner progress");
    expect(progressView).toHaveTextContent(/first-spark v1: completed, 100%/i);

    await user.selectOptions(screen.getByLabelText("Compile state"), "failed");
    await user.type(screen.getByLabelText("Safe error code"), "COMPILE_FAILED");
    await user.click(screen.getByRole("button", { name: "Filter diagnostics" }));
    await user.type(screen.getByLabelText("Action filter"), "kit.revoke");
    await user.click(screen.getByRole("button", { name: "Filter audit history" }));

    await waitFor(() => {
      expect(requests.some((request) =>
        request.path === "/api/admin/learners?q=ada%40example.com&limit=20&offset=0"
      )).toBe(true);
      expect(requests.some((request) =>
        request.path === "/api/admin/compile-diagnostics?state=failed&errorCode=COMPILE_FAILED&limit=20&offset=0"
      )).toBe(true);
      expect(requests.some((request) =>
        request.path === "/api/admin/audit?action=kit.revoke&limit=20&offset=0"
      )).toBe(true);
    });
    expect(screen.getByText(/Learner source code is never returned/i)).toBeInTheDocument();
    expect(screen.getByText("kit.batch_created")).toBeInTheDocument();
  });
});
