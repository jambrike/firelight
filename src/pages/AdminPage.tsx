import { FileClock, KeySquare, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SyntheticEvent } from "react";
import {
  ADMIN_KIT_BATCH_MAX_CODES,
  ADMIN_PAGE_DEFAULT_LIMIT,
  type AdminAuditEntry,
  type AdminCompileDiagnostic,
  type AdminCompileState,
  type AdminKitCodeState,
  type AdminKitRecord,
  type AdminKitRevocationInput,
  type AdminLearnerProgress,
  type AdminLearnerSummary,
  type AdminPage,
  type GeneratedKitBatch,
} from "../../shared/admin";
import { PageIntro, Panel, StatusRegion } from "../components/ui";
import { FirelightApi } from "../features/identity/api";
import { useIdentity } from "../features/identity/identity-context";

type AdminAction =
  | "initial"
  | "generate"
  | "kits"
  | "revoke"
  | "learners"
  | "progress"
  | "diagnostics"
  | "audit";

const revocationReasons: readonly {
  readonly value: AdminKitRevocationInput["reason"];
  readonly label: string;
}[] = [
  { value: "lost", label: "Kit or code was lost" },
  { value: "damaged", label: "Kit was damaged" },
  { value: "support", label: "Support correction" },
  { value: "security", label: "Security response" },
  { value: "other", label: "Other documented reason" },
];

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Firelight could not complete the request.";
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  return new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function downloadCsv(filename: string, value: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "batch";
}

function PageControls<T>({
  page,
  disabled,
  label,
  onPage,
}: {
  readonly page: AdminPage<T>;
  readonly disabled: boolean;
  readonly label: string;
  readonly onPage: (offset: number) => void;
}) {
  const previousOffset = Math.max(0, page.offset - page.limit);
  return (
    <nav className="button-row" aria-label={`${label} pages`}>
      <button
        className="pixel-button pixel-button--secondary"
        type="button"
        disabled={disabled || page.offset === 0}
        onClick={() => { onPage(previousOffset); }}
      >
        Previous
      </button>
      <span>
        Showing {page.items.length === 0 ? 0 : page.offset + 1}–{page.offset + page.items.length}
      </span>
      <button
        className="pixel-button pixel-button--secondary"
        type="button"
        disabled={disabled || page.nextOffset === null}
        onClick={() => {
          if (page.nextOffset !== null) onPage(page.nextOffset);
        }}
      >
        Next
      </button>
    </nav>
  );
}

export function AdminPage() {
  const identity = useIdentity();
  const accessToken = identity.session?.access_token ?? null;
  const api = useMemo(() => new FirelightApi(() => accessToken), [accessToken]);
  const [busy, setBusy] = useState<AdminAction | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [batch, setBatch] = useState("");
  const [count, setCount] = useState("10");
  const [generatedBatch, setGeneratedBatch] = useState<GeneratedKitBatch | null>(null);

  const [kitQuery, setKitQuery] = useState("");
  const [kitState, setKitState] = useState<AdminKitCodeState | "">("");
  const [kits, setKits] = useState<AdminPage<AdminKitRecord> | null>(null);
  const [revocationKit, setRevocationKit] = useState<AdminKitRecord | null>(null);
  const [revocationReason, setRevocationReason] =
    useState<AdminKitRevocationInput["reason"]>("support");
  const [revocationConfirmation, setRevocationConfirmation] = useState("");

  const [learnerQuery, setLearnerQuery] = useState("");
  const [learners, setLearners] = useState<AdminPage<AdminLearnerSummary> | null>(null);
  const [learnerProgress, setLearnerProgress] = useState<AdminLearnerProgress | null>(null);

  const [compileState, setCompileState] = useState<AdminCompileState | "">("");
  const [errorCode, setErrorCode] = useState("");
  const [diagnostics, setDiagnostics] =
    useState<AdminPage<AdminCompileDiagnostic> | null>(null);

  const [auditAction, setAuditAction] = useState("");
  const [audit, setAudit] = useState<AdminPage<AdminAuditEntry> | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    const loads = [
      api.listAdminKits({ limit: ADMIN_PAGE_DEFAULT_LIMIT, offset: 0 }).then((result) => {
        if (active) setKits(result);
      }),
      api.searchAdminLearners({ limit: ADMIN_PAGE_DEFAULT_LIMIT, offset: 0 }).then((result) => {
        if (active) setLearners(result);
      }),
      api.listAdminCompileDiagnostics({ limit: ADMIN_PAGE_DEFAULT_LIMIT, offset: 0 }).then((result) => {
        if (active) setDiagnostics(result);
      }),
      api.listAdminAudit({ limit: ADMIN_PAGE_DEFAULT_LIMIT, offset: 0 }).then((result) => {
        if (active) setAudit(result);
      }),
    ];
    void Promise.allSettled(loads).then((results) => {
      if (!active) return;
      const failure = results.find((result) => result.status === "rejected");
      setFeedback(
        failure?.status === "rejected"
          ? messageFrom(failure.reason)
          : "Pilot support data loaded.",
      );
    });
    return () => {
      active = false;
    };
  }, [accessToken, api]);

  const loadKits = async (offset = 0) => {
    setBusy("kits");
    setFeedback(null);
    try {
      setKits(
        await api.listAdminKits({
          q: kitQuery,
          ...(kitState ? { state: kitState } : {}),
          limit: ADMIN_PAGE_DEFAULT_LIMIT,
          offset,
        }),
      );
      setFeedback("Kit inventory refreshed.");
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setBusy(null);
    }
  };

  const generateBatch = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (generatedBatch) return;
    setBusy("generate");
    setFeedback(null);
    try {
      const result = await api.createAdminKitBatch({ batch: batch.trim(), count: Number(count) });
      setGeneratedBatch(result);
      const successMessage = `${String(result.codes.length)} plaintext kit code(s) generated. Export them now; Firelight cannot show them again.`;
      try {
        setKits(await api.listAdminKits({
          q: kitQuery,
          ...(kitState ? { state: kitState } : {}),
          limit: ADMIN_PAGE_DEFAULT_LIMIT,
          offset: 0,
        }));
        setFeedback(successMessage);
      } catch {
        setFeedback(`${successMessage} Kit inventory could not refresh.`);
      }
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setBusy(null);
    }
  };

  const revokeKit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (!revocationKit || revocationConfirmation !== "REVOKE") return;
    setBusy("revoke");
    setFeedback(null);
    try {
      const result = await api.revokeAdminKit(revocationKit.id, { reason: revocationReason });
      setRevocationKit(null);
      setRevocationConfirmation("");
      const successMessage = result.accessRevoked
        ? "Kit code revoked and the learner's activation access removed."
        : "Kit code is revoked; no active learner access was attached.";
      try {
        setKits(await api.listAdminKits({
          q: kitQuery,
          ...(kitState ? { state: kitState } : {}),
          limit: ADMIN_PAGE_DEFAULT_LIMIT,
          offset: kits?.offset ?? 0,
        }));
        setFeedback(successMessage);
      } catch {
        setFeedback(`${successMessage} Kit inventory could not refresh.`);
      }
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setBusy(null);
    }
  };

  const loadLearners = async (offset = 0) => {
    setBusy("learners");
    setFeedback(null);
    try {
      setLearners(
        await api.searchAdminLearners({
          q: learnerQuery,
          limit: ADMIN_PAGE_DEFAULT_LIMIT,
          offset,
        }),
      );
      setLearnerProgress(null);
      setFeedback("Learner results refreshed.");
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setBusy(null);
    }
  };

  const loadProgress = async (learnerId: string, offset = 0) => {
    setBusy("progress");
    setFeedback(null);
    try {
      setLearnerProgress(
        await api.getAdminLearnerProgress(learnerId, {
          limit: ADMIN_PAGE_DEFAULT_LIMIT,
          offset,
        }),
      );
      setFeedback("Learner progress loaded.");
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setBusy(null);
    }
  };

  const loadDiagnostics = async (offset = 0) => {
    setBusy("diagnostics");
    setFeedback(null);
    try {
      setDiagnostics(
        await api.listAdminCompileDiagnostics({
          ...(compileState ? { state: compileState } : {}),
          errorCode,
          limit: ADMIN_PAGE_DEFAULT_LIMIT,
          offset,
        }),
      );
      setFeedback("Compile diagnostics refreshed.");
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setBusy(null);
    }
  };

  const loadAudit = async (offset = 0) => {
    setBusy("audit");
    setFeedback(null);
    try {
      setAudit(
        await api.listAdminAudit({
          action: auditAction,
          limit: ADMIN_PAGE_DEFAULT_LIMIT,
          offset,
        }),
      );
      setFeedback("Audit history refreshed.");
    } catch (error) {
      setFeedback(messageFrom(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Pilot support" title="A small console for keeping builders moving.">
        <p>
          Create activation inventory, inspect learner progress, and review safe operational
          diagnostics. Every privileged request is server-authorized and audited.
        </p>
      </PageIntro>

      {feedback ? <StatusRegion>{feedback}</StatusRegion> : null}

      <Panel>
        <KeySquare aria-hidden="true" />
        <h2>Generate kit-code batch</h2>
        <p>
          Plaintext codes are returned once beside their revocation IDs and stay only in this
          page's memory. Export the pairs before clearing or leaving this route.
        </p>
        <form className="identity-form" onSubmit={(event) => { void generateBatch(event); }}>
          <label>
            Batch name
            <input
              name="batch"
              required
              minLength={1}
              maxLength={80}
              value={batch}
              disabled={generatedBatch !== null}
              onChange={(event) => { setBatch(event.currentTarget.value); }}
            />
          </label>
          <label>
            Number of codes
            <input
              name="count"
              type="number"
              required
              min={1}
              max={ADMIN_KIT_BATCH_MAX_CODES}
              value={count}
              disabled={generatedBatch !== null}
              onChange={(event) => { setCount(event.currentTarget.value); }}
            />
          </label>
          <button
            className="pixel-button"
            type="submit"
            disabled={busy !== null || generatedBatch !== null}
          >
            {busy === "generate" ? "Generating…" : "Generate one-time codes"}
          </button>
        </form>

        {generatedBatch ? (
          <aside className="feature-placeholder" aria-label="One-time plaintext kit codes">
            <span className="status-chip">Export before clearing</span>
            <h3>{generatedBatch.batch}</h3>
            <p>
              Generated {formatTimestamp(generatedBatch.generatedAt)}. The IDs remain searchable,
              but these plaintext codes cannot be recovered.
            </p>
            <ol>
              {generatedBatch.codes.map((entry) => (
                <li key={entry.id}>
                  <code>{entry.code}</code>
                  <br />
                  <small>Kit ID <code>{entry.id}</code></small>
                </li>
              ))}
            </ol>
            <div className="button-row">
              <button
                className="pixel-button pixel-button--secondary"
                type="button"
                onClick={() => {
                  downloadCsv(
                    `firelight-kit-codes-${safeFilename(generatedBatch.batch)}.csv`,
                    `kit_id,code\n${generatedBatch.codes
                      .map((entry) => `${entry.id},${entry.code}`)
                      .join("\n")}\n`,
                  );
                  setFeedback("Kit references and plaintext codes exported.");
                }}
              >
                Export code-reference pairs
              </button>
              <button
                className="pixel-button danger-button"
                type="button"
                onClick={() => {
                  setGeneratedBatch(null);
                  setFeedback("Plaintext kit codes cleared from this page.");
                }}
              >
                Clear plaintext codes
              </button>
            </div>
          </aside>
        ) : null}
      </Panel>

      <Panel>
        <KeySquare aria-hidden="true" />
        <h2>Kit inventory and revocation</h2>
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadKits(0);
          }}
        >
          <label>
            Search batch or kit reference
            <input
              type="search"
              value={kitQuery}
              onChange={(event) => { setKitQuery(event.currentTarget.value); }}
            />
          </label>
          <label>
            Kit state
            <select value={kitState} onChange={(event) => {
              setKitState(event.currentTarget.value as AdminKitCodeState | "");
            }}>
              <option value="">All states</option>
              <option value="issued">Issued</option>
              <option value="claimed">Claimed</option>
              <option value="revoked">Revoked</option>
            </select>
          </label>
          <button className="pixel-button pixel-button--secondary" type="submit" disabled={busy !== null}>
            Search kits
          </button>
        </form>

        {kits ? (
          <>
            <ul className="page-stack" aria-label="Kit inventory results">
              {kits.items.map((kit) => (
                <li key={kit.id}>
                  <strong>{kit.batch}</strong> · {kit.state}
                  <br />
                  <code>{kit.id}</code>
                  <br />
                  <span>
                    Created {formatTimestamp(kit.createdAt)} · Claimed {formatTimestamp(kit.claimedAt)}
                  </span>
                  {kit.state !== "revoked" ? (
                    <div className="button-row">
                      <button
                        className="pixel-button danger-button"
                        type="button"
                        onClick={() => {
                          setRevocationKit(kit);
                          setRevocationConfirmation("");
                        }}
                      >
                        Revoke {kit.batch} kit
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {kits.items.length === 0 ? <p>No kit codes match these filters.</p> : null}
            <PageControls
              page={kits}
              disabled={busy !== null}
              label="Kit inventory"
              onPage={(offset) => { void loadKits(offset); }}
            />
          </>
        ) : null}

        {revocationKit ? (
          <form className="identity-form danger-panel" onSubmit={(event) => { void revokeKit(event); }}>
            <h3>Confirm kit-code revocation</h3>
            <p>
              Revoking <code>{revocationKit.id}</code> is permanent.
              {revocationKit.claimedBy
                ? " The linked learner will immediately lose activated access."
                : " This unclaimed code will never be claimable."}
            </p>
            <label>
              Revocation reason
              <select
                value={revocationReason}
                onChange={(event) => {
                  setRevocationReason(event.currentTarget.value as AdminKitRevocationInput["reason"]);
                }}
              >
                {revocationReasons.map((reason) => (
                  <option key={reason.value} value={reason.value}>{reason.label}</option>
                ))}
              </select>
            </label>
            <label>
              Type REVOKE exactly to confirm the selected reason
              <input
                autoComplete="off"
                value={revocationConfirmation}
                onChange={(event) => { setRevocationConfirmation(event.currentTarget.value); }}
              />
            </label>
            <div className="button-row">
              <button
                className="pixel-button danger-button"
                type="submit"
                disabled={busy !== null || revocationConfirmation !== "REVOKE"}
              >
                Confirm revocation
              </button>
              <button
                className="pixel-button pixel-button--secondary"
                type="button"
                disabled={busy !== null}
                onClick={() => { setRevocationKit(null); }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </Panel>

      <Panel>
        <Search aria-hidden="true" />
        <h2>Learner lookup and progress</h2>
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadLearners(0);
          }}
        >
          <label>
            Search email, display name, or learner ID
            <input
              type="search"
              value={learnerQuery}
              onChange={(event) => { setLearnerQuery(event.currentTarget.value); }}
            />
          </label>
          <button className="pixel-button pixel-button--secondary" type="submit" disabled={busy !== null}>
            Search learners
          </button>
        </form>

        {learners ? (
          <>
            <ul className="page-stack" aria-label="Learner search results">
              {learners.items.map((learner) => (
                <li key={learner.id}>
                  <strong>{learner.displayName}</strong> · {learner.email}
                  <br />
                  <span>
                    {learner.completedLessons} completed · {learner.progressRecords} saved · access {learner.accessSource ?? "none"}
                  </span>
                  <div className="button-row">
                    <button
                      className="pixel-button pixel-button--secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => { void loadProgress(learner.id, 0); }}
                    >
                      Inspect {learner.displayName}'s progress
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {learners.items.length === 0 ? <p>No learners match this search.</p> : null}
            <PageControls
              page={learners}
              disabled={busy !== null}
              label="Learner results"
              onPage={(offset) => { void loadLearners(offset); }}
            />
          </>
        ) : null}

        {learnerProgress ? (
          <aside className="feature-placeholder" aria-label="Selected learner progress">
            <span className="status-chip">Read-only support view</span>
            <h3>{learnerProgress.learner.displayName}</h3>
            <p>{learnerProgress.learner.email}</p>
            <ul>
              {learnerProgress.progress.items.map((record) => (
                <li key={`${record.lessonId}-${String(record.lessonVersion)}`}>
                  <strong>{record.lessonId}</strong> v{record.lessonVersion}: {record.status}, {record.percentage}%
                  <br />
                  Step {record.currentStep} · updated {formatTimestamp(record.updatedAt)}
                </li>
              ))}
            </ul>
            {learnerProgress.progress.items.length === 0 ? <p>No lesson progress recorded.</p> : null}
            <PageControls
              page={learnerProgress.progress}
              disabled={busy !== null}
              label="Selected learner progress"
              onPage={(offset) => { void loadProgress(learnerProgress.learner.id, offset); }}
            />
          </aside>
        ) : null}
      </Panel>

      <Panel>
        <TriangleAlert aria-hidden="true" />
        <h2>Bounded compile diagnostics</h2>
        <p>Only safe summaries are shown, {ADMIN_PAGE_DEFAULT_LIMIT} records at a time. Learner source code is never returned.</p>
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadDiagnostics(0);
          }}
        >
          <label>
            Compile state
            <select value={compileState} onChange={(event) => {
              setCompileState(event.currentTarget.value as AdminCompileState | "");
            }}>
              <option value="">All states</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label>
            Safe error code
            <input value={errorCode} onChange={(event) => { setErrorCode(event.currentTarget.value); }} />
          </label>
          <button className="pixel-button pixel-button--secondary" type="submit" disabled={busy !== null}>
            Filter diagnostics
          </button>
        </form>
        {diagnostics ? (
          <>
            <ul className="page-stack" aria-label="Compile diagnostic results">
              {diagnostics.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.lessonId}</strong> · {item.state} · {item.safeErrorCode ?? "no error code"}
                  <br />
                  <span>{item.diagnosticSummary}</span>
                  <br />
                  <small>{formatTimestamp(item.createdAt)} · {item.durationMs ?? "—"} ms</small>
                </li>
              ))}
            </ul>
            {diagnostics.items.length === 0 ? <p>No compile diagnostics match these filters.</p> : null}
            <PageControls
              page={diagnostics}
              disabled={busy !== null}
              label="Compile diagnostics"
              onPage={(offset) => { void loadDiagnostics(offset); }}
            />
          </>
        ) : null}
      </Panel>

      <Panel>
        <FileClock aria-hidden="true" />
        <h2>Admin audit history</h2>
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadAudit(0);
          }}
        >
          <label>
            Action filter
            <input value={auditAction} onChange={(event) => { setAuditAction(event.currentTarget.value); }} />
          </label>
          <button className="pixel-button pixel-button--secondary" type="submit" disabled={busy !== null}>
            Filter audit history
          </button>
        </form>
        {audit ? (
          <>
            <ol className="page-stack" aria-label="Admin audit results">
              {audit.items.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.action}</strong> · {entry.targetType} {entry.targetId ?? "—"}
                  <br />
                  <span>{formatTimestamp(entry.createdAt)} · actor {entry.actorId ?? "system"}</span>
                  {Object.keys(entry.metadata).length > 0 ? (
                    <details>
                      <summary>Audit metadata</summary>
                      <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
            {audit.items.length === 0 ? <p>No audit entries match this filter.</p> : null}
            <PageControls
              page={audit}
              disabled={busy !== null}
              label="Audit history"
              onPage={(offset) => { void loadAudit(offset); }}
            />
          </>
        ) : null}
      </Panel>
    </div>
  );
}
