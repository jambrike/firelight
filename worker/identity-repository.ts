import type {
  KitActivation,
  KitActivationKind,
  LessonProgress,
  ProfileRole,
  ProgressUpdateInput,
} from "../shared/identity";
import type {
  AdminAuditEntry,
  AdminCompileDiagnostic,
  AdminCompileState,
  AdminKitCodeState,
  AdminKitRecord,
  AdminKitRevocationInput,
  AdminKitRevocationResult,
  AdminLearnerSummary,
  AdminPage,
  AdminProgressRecord,
} from "../shared/admin";
import { ADMIN_PAGE_MAX_OFFSET } from "../shared/admin";
import {
  ACCOUNT_EXPORT_MAX_COMPILE_JOBS,
  ACCOUNT_EXPORT_MAX_PROGRESS_RECORDS,
  ACCOUNT_EXPORT_MAX_RESPONSE_BYTES,
  ACCOUNT_EXPORT_MAX_UPLOAD_EVIDENCE,
  ACCOUNT_EXPORT_SCHEMA,
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  type AccountExportCompileJob,
} from "../shared/account-export";
import { curriculumLessons, isLessonSlug } from "../shared/curriculum";
import {
  FIRELIGHT_BOARD_FQBN,
  isRfc3339Timestamp,
  MAX_NANO_UPLOAD_BYTES,
  type UploadEvidence,
} from "../shared/hardware";

const MAX_UPSTREAM_JSON_BYTES = 3 * 1024 * 1024;
const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;
// JSON escaping can expand snapshots sixfold and diagnostics twofold. These
// page sizes keep every maximum-sized projection below the 3 MiB reader cap.
const ACCOUNT_EXPORT_PROGRESS_PAGE_SIZE = 4;
const ACCOUNT_EXPORT_COMPILE_PAGE_SIZE = 128;
const ACCOUNT_EXPORT_UPLOAD_PAGE_SIZE = 1_000;
const PROGRESS_SELECT =
  "lesson_id,lesson_version,revision,status,current_step,percentage,code_snapshot,completion_evidence_id,completed_at,updated_at";
const ACCOUNT_EXPORT_PROGRESS_SELECT = `user_id,${PROGRESS_SELECT}`;
const ACCOUNT_EXPORT_COMPILE_SELECT =
  "user_id,id,lesson_id,lesson_version,board_target,source_hash,state,duration_ms,safe_error_code,artifact_hash,diagnostic_summary,created_at,started_at,finished_at";
const ACCOUNT_EXPORT_UPLOAD_SELECT =
  "user_id,id,compile_job_id,lesson_id,lesson_version,source_hash,artifact_hash,bytes_written,attestation_kind,recorded_at";

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailConfirmed: boolean;
  readonly lastSignInAt: string | null;
  /** Session identifier from the exact access token authenticated for this request. */
  readonly sessionId: string | null;
  readonly isAnonymous: boolean;
}

export interface ProfileRecord {
  readonly id: string;
  readonly displayName: string;
  readonly role: ProfileRole;
  readonly accessSource: KitActivationKind | null;
  readonly accessGrantedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BootstrapRecords {
  readonly profile: ProfileRecord;
  readonly activation: KitActivation | null;
  readonly progress: readonly LessonProgress[];
}

export interface AccountExportRecords {
  readonly profile: ProfileRecord;
  readonly activation: KitActivation | null;
  readonly progress: readonly LessonProgress[];
  readonly compileJobs: readonly AccountExportCompileJob[];
  readonly uploadEvidence: readonly UploadEvidence[];
}

export type CompileJobGate =
  | { readonly result: "started"; readonly jobId: string }
  | { readonly result: "active" }
  | {
      readonly result: "rate_limited";
      readonly scope: "hour" | "day";
      readonly retryAfterSeconds: number;
    }
  | { readonly result: "not_entitled" };

export interface BeginCompileJobInput {
  readonly lessonId: string;
  readonly lessonVersion: number;
  readonly sourceHash: string;
}

export interface FinishCompileJobInput {
  readonly jobId: string;
  readonly state: "succeeded" | "failed";
  readonly durationMs: number;
  readonly safeErrorCode: string | null;
  readonly artifactHash: string | null;
  readonly diagnosticSummary: string;
}

export interface AdminPageInput {
  readonly limit: number;
  readonly offset: number;
}

export interface AdminKitBatchCreationResult {
  readonly batch: string;
  readonly count: number;
  readonly createdAt: string;
}

export type RepositoryErrorKind =
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "kit_invalid"
  | "export_too_large"
  | "invalid"
  | "unavailable";

export class RepositoryError extends Error {
  readonly kind: RepositoryErrorKind;
  readonly upstreamCode: string | null;

  constructor(kind: RepositoryErrorKind, message: string, upstreamCode: string | null = null) {
    super(message);
    this.name = "RepositoryError";
    this.kind = kind;
    this.upstreamCode = upstreamCode;
  }
}

export interface IdentityRepository {
  authenticate(): Promise<AuthenticatedUser>;
  getBootstrap(userId: string): Promise<BootstrapRecords>;
  getAccountExport(userId: string): Promise<AccountExportRecords>;
  updateProfile(userId: string, displayName: string): Promise<ProfileRecord>;
  claimKit(userId: string, codeHash: string): Promise<KitActivation>;
  hasActivation(userId: string): Promise<boolean>;
  beginCompileJob(userId: string, input: BeginCompileJobInput): Promise<CompileJobGate>;
  finishCompileJob(userId: string, input: FinishCompileJobInput): Promise<void>;
  recordUploadEvidence(
    userId: string,
    compileJobId: string,
    artifactHash: string,
    bytesWritten: number,
  ): Promise<UploadEvidence>;
  upsertProgress(
    userId: string,
    lessonId: string,
    input: ProgressUpdateInput,
  ): Promise<LessonProgress>;
  hasRecentSession(userId: string, sessionId: string): Promise<boolean>;
  deleteAccount(userId: string): Promise<void>;
  isAdmin(userId: string): Promise<boolean>;
  createAdminKitBatch(
    actorId: string,
    batch: string,
    codeIds: readonly string[],
    codeHashes: readonly string[],
  ): Promise<AdminKitBatchCreationResult>;
  listAdminKits(
    actorId: string,
    query: string,
    state: AdminKitCodeState | null,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminKitRecord>>;
  revokeAdminKit(
    actorId: string,
    kitId: string,
    reason: AdminKitRevocationInput["reason"],
  ): Promise<AdminKitRevocationResult | null>;
  listAdminLearners(
    actorId: string,
    query: string,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminLearnerSummary>>;
  listAdminProgress(
    actorId: string,
    learnerId: string,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminProgressRecord>>;
  listAdminCompileDiagnostics(
    actorId: string,
    state: AdminCompileState | null,
    errorCode: string | null,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminCompileDiagnostic>>;
  listAdminAudit(
    actorId: string,
    action: string | null,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminAuditEntry>>;
}

export type IdentityRepositoryFactory = (
  env: Env,
  accessToken: string,
) => IdentityRepository;

export type RepositoryFetcher = (
  input: URL,
  init: RequestInit,
) => Promise<Response>;

class SupabaseRequestDeadlineError extends Error {
  constructor() {
    super("Supabase request deadline exceeded.");
    this.name = "SupabaseRequestDeadlineError";
  }
}

interface SupabaseErrorBody {
  readonly code: string | null;
  readonly message: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readConfiguredValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configuredSupabaseUrl(
  value: string,
  environment: string,
  expectedProjectRef: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RepositoryError("unavailable", "Supabase is not configured.");
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const isDevelopmentLoopback =
    environment === "development" &&
    expectedProjectRef === "local" &&
    isLoopback &&
    parsed.protocol === "http:" &&
    parsed.port.length > 0;
  const isHostedProject =
    (environment === "staging" || environment === "production") &&
    parsed.protocol === "https:" &&
    /^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname) &&
    parsed.port.length === 0 &&
    /^[a-z0-9]{20}$/.test(expectedProjectRef) &&
    parsed.hostname === `${expectedProjectRef}.supabase.co`;
  if (
    (!isDevelopmentLoopback && !isHostedProject) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new RepositoryError("unavailable", "Supabase is not configured.");
  }
  return new URL(parsed.origin);
}

interface AccessTokenClaims {
  readonly subject: string | null;
  readonly sessionId: string | null;
}

function parseSupabaseTokenClaims(accessToken: string, baseUrl: URL): AccessTokenClaims {
  const segments = accessToken.split(".");
  if (segments.length !== 3 || !segments[1]) {
    throw new RepositoryError("unauthorized", "Session rejected.");
  }
  try {
    const base64 = segments[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(payload) || payload.iss !== `${baseUrl.origin}/auth/v1`) {
      throw new Error("issuer mismatch");
    }
    const sessionId = typeof payload.session_id === "string" && UUID_PATTERN.test(payload.session_id)
      ? payload.session_id
      : null;
    return {
      subject: typeof payload.sub === "string" ? payload.sub : null,
      sessionId,
    };
  } catch {
    throw new RepositoryError("unauthorized", "Session rejected.");
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function readUuid(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!UUID_PATTERN.test(value)) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

function readUuidV4(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!UUID_V4_PATTERN.test(value)) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

function readNullableUuid(record: Record<string, unknown>, key: string): string | null {
  const value = readNullableString(record, key);
  if (value !== null && !UUID_PATTERN.test(value)) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

function readSha256(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!SHA256_PATTERN.test(value)) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

function readNullableSha256(record: Record<string, unknown>, key: string): string | null {
  if (record[key] === null) return null;
  return readSha256(record, key);
}

function readTimestamp(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (
    !isRfc3339Timestamp(value)
  ) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

function parseProfile(value: unknown): ProfileRecord {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid profile.");
  }

  const role = readString(value, "role");
  const accessSource = readNullableString(value, "access_source");
  if (role !== "learner" && role !== "admin") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid profile role.");
  }
  if (accessSource !== null && accessSource !== "code" && accessSource !== "grandfathered") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid access source.");
  }

  return {
    id: readUuid(value, "id"),
    displayName: readBoundedText(value, "display_name", 1, 40),
    role,
    accessSource,
    accessGrantedAt: readNullableTimestamp(value, "access_granted_at"),
    createdAt: readTimestamp(value, "created_at"),
    updatedAt: readTimestamp(value, "updated_at"),
  };
}

function parseActivation(value: unknown): KitActivation {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid activation.");
  }

  const kind = readString(value, "kind");
  if (kind !== "code" && kind !== "grandfathered") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid activation kind.");
  }

  return {
    id: readUuid(value, "id"),
    batch: readBoundedText(value, "batch", 1, 80),
    kind,
    claimedAt: readTimestamp(value, "claimed_at"),
  };
}

function parseProgress(value: unknown): LessonProgress {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned invalid lesson progress.");
  }

  const lessonId = readString(value, "lesson_id");
  const status = readString(value, "status");
  const lessonVersion = value.lesson_version;
  const revision = value.revision;
  const percentage = value.percentage;
  const codeSnapshot = readNullableString(value, "code_snapshot");
  if (!isLessonSlug(lessonId)) {
    throw new RepositoryError("unavailable", "Supabase returned an unknown lesson.");
  }
  if (status !== "not_started" && status !== "in_progress" && status !== "completed") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid progress status.");
  }
  if (
    !Number.isSafeInteger(lessonVersion) ||
    Number(lessonVersion) < 1 ||
    Number(lessonVersion) > 1_000_000 ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    Number(revision) > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(percentage) ||
    Number(percentage) < 0 ||
    Number(percentage) > 100 ||
    (codeSnapshot !== null && new TextEncoder().encode(codeSnapshot).byteLength > 65_536)
  ) {
    throw new RepositoryError("unavailable", "Supabase returned invalid progress numbers.");
  }

  return {
    lessonId,
    lessonVersion: Number(lessonVersion),
    revision: Number(revision),
    status,
    currentStep: readBoundedText(value, "current_step", 1, 100),
    percentage: Number(percentage),
    codeSnapshot,
    completionEvidenceId: readNullableUuid(value, "completion_evidence_id"),
    completedAt: readNullableTimestamp(value, "completed_at"),
    updatedAt: readTimestamp(value, "updated_at"),
  };
}

function parseSavedProgress(value: unknown): LessonProgress | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new RepositoryError("unavailable", "Supabase did not return valid saved progress.");
  }
  return value.length === 1 ? parseProgress(value[0]) : null;
}

function readNullableTimestamp(record: Record<string, unknown>, key: string): string | null {
  const value = readNullableString(record, key);
  if (value !== null && !isRfc3339Timestamp(value)) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return value;
}

function readSafeInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  return Number(value);
}

function readNullableSafeInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | null {
  if (record[key] === null) return null;
  return readSafeInteger(record, key, minimum, maximum);
}

function readBoundedText(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string {
  const value = readString(record, key);
  const length = Array.from(value).length;
  if (length < minimum || length > maximum) {
    throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      throw new RepositoryError("unavailable", `Supabase returned an invalid ${key}.`);
    }
  }
  return value;
}

function requireExportOwner(
  record: Record<string, unknown>,
  expectedUserId: string,
): void {
  if (readUuid(record, "user_id") !== expectedUserId) {
    throw new RepositoryError("unavailable", "Supabase returned another owner's data.");
  }
}

function parseAccountExportProgress(value: unknown, expectedUserId: string): LessonProgress {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned invalid export progress.");
  }
  requireExportOwner(value, expectedUserId);
  return parseProgress(value);
}

function parseAccountExportCompileJob(
  value: unknown,
  expectedUserId: string,
): AccountExportCompileJob {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid export compile job.");
  }
  requireExportOwner(value, expectedUserId);
  const lessonId = readString(value, "lesson_id");
  const state = readString(value, "state");
  const safeErrorCode = readNullableString(value, "safe_error_code");
  const diagnosticSummary = readBoundedText(value, "diagnostic_summary", 0, 8_192);
  if (
    !isLessonSlug(lessonId) ||
    (state !== "queued" && state !== "running" && state !== "succeeded" && state !== "failed") ||
    (safeErrorCode !== null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(safeErrorCode)) ||
    new TextEncoder().encode(diagnosticSummary).byteLength > 8_192
  ) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid export compile job.");
  }
  const boardTarget = readString(value, "board_target");
  if (boardTarget !== FIRELIGHT_BOARD_FQBN) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid export board target.");
  }
  return {
    id: readUuid(value, "id"),
    lessonId,
    lessonVersion: readSafeInteger(value, "lesson_version", 1, 1_000_000),
    boardTarget,
    sourceHash: readSha256(value, "source_hash"),
    state,
    durationMs: readNullableSafeInteger(value, "duration_ms", 0, 60_000),
    safeErrorCode,
    artifactHash: readNullableSha256(value, "artifact_hash"),
    diagnosticSummary,
    createdAt: readTimestamp(value, "created_at"),
    startedAt: readNullableTimestamp(value, "started_at"),
    finishedAt: readNullableTimestamp(value, "finished_at"),
  };
}

function parseAccountExportUploadEvidence(
  value: unknown,
  expectedUserId: string,
): UploadEvidence {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned invalid export upload evidence.");
  }
  requireExportOwner(value, expectedUserId);
  const lessonId = readString(value, "lesson_id");
  const attestation = readString(value, "attestation_kind");
  if (!isLessonSlug(lessonId) || attestation !== "browser-web-serial-v1") {
    throw new RepositoryError("unavailable", "Supabase returned invalid export upload evidence.");
  }
  return {
    id: readUuidV4(value, "id"),
    compileJobId: readUuidV4(value, "compile_job_id"),
    lessonId,
    lessonVersion: readSafeInteger(value, "lesson_version", 1, 1_000_000),
    sourceHash: readSha256(value, "source_hash"),
    artifactHash: readSha256(value, "artifact_hash"),
    bytesWritten: readSafeInteger(value, "bytes_written", 1, MAX_NANO_UPLOAD_BYTES),
    recordedAt: readTimestamp(value, "recorded_at"),
    attestation,
  };
}

interface AccountExportSerializedBudget {
  serializedBytes: number;
}

function serializedJsonByteLength(value: object): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function createAccountExportSerializedBudget(
  profile: ProfileRecord,
  activation: KitActivation | null,
): AccountExportSerializedBudget {
  return {
    // This is a mechanical lower bound for the final versioned API envelope:
    // every real email/export timestamp adds bytes, and `true` is the shorter
    // possible confirmation value. The endpoint performs the exact final check.
    serializedBytes: serializedJsonByteLength({
      data: {
        schema: ACCOUNT_EXPORT_SCHEMA,
        version: ACCOUNT_EXPORT_SCHEMA_VERSION,
        exportedAt: "",
        data: {
          profile: {
            id: profile.id,
            displayName: profile.displayName,
            role: profile.role,
            email: "",
            emailConfirmed: true,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          },
          activation,
          progress: [],
          compileJobs: [],
          uploadEvidence: [],
        },
      },
    }),
  };
}

function retainAccountExportRow<T extends object>(
  rows: T[],
  row: T,
  budget: AccountExportSerializedBudget,
): void {
  const separatorBytes = rows.length === 0 ? 0 : 1;
  const nextBytes = serializedJsonByteLength(row) + separatorBytes;
  if (budget.serializedBytes + nextBytes > ACCOUNT_EXPORT_MAX_RESPONSE_BYTES) {
    throw new RepositoryError(
      "export_too_large",
      "The complete account export exceeds the supported response size.",
    );
  }
  budget.serializedBytes += nextBytes;
  rows.push(row);
}

function parseAdminPage<T>(
  value: unknown,
  page: AdminPageInput,
  parseItem: (item: unknown) => T,
): AdminPage<T> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > page.limit ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid admin page.");
  }
  const nextOffset = page.offset + page.limit;
  return {
    items: value.items.map((item) => parseItem(item)),
    limit: page.limit,
    offset: page.offset,
    nextOffset:
      value.hasMore && nextOffset <= ADMIN_PAGE_MAX_OFFSET ? nextOffset : null,
  };
}

function parseAdminKit(value: unknown): AdminKitRecord {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid kit record.");
  }
  const state = readString(value, "state");
  if (state !== "issued" && state !== "claimed" && state !== "revoked") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid kit state.");
  }
  return {
    id: readUuid(value, "id"),
    batch: readBoundedText(value, "batch", 1, 80),
    state,
    claimedBy: readNullableUuid(value, "claimedBy"),
    claimedAt: readNullableTimestamp(value, "claimedAt"),
    revokedAt: readNullableTimestamp(value, "revokedAt"),
    createdAt: readTimestamp(value, "createdAt"),
  };
}

function parseAdminLearner(value: unknown): AdminLearnerSummary {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid learner record.");
  }
  const role = readString(value, "role");
  const accessSource = readNullableString(value, "accessSource");
  if (role !== "learner" && role !== "admin") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid learner role.");
  }
  if (accessSource !== null && accessSource !== "code" && accessSource !== "grandfathered") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid learner access source.");
  }
  const activationBatch = readNullableString(value, "activationBatch");
  if (activationBatch !== null && Array.from(activationBatch).length > 80) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid activation batch.");
  }
  return {
    id: readUuid(value, "id"),
    email: readBoundedText(value, "email", 0, 320),
    displayName: readBoundedText(value, "displayName", 1, 40),
    role,
    accessSource,
    activationBatch,
    completedLessons: readSafeInteger(value, "completedLessons", 0, 1_000_000),
    progressRecords: readSafeInteger(value, "progressRecords", 0, 1_000_000),
    createdAt: readTimestamp(value, "createdAt"),
    updatedAt: readTimestamp(value, "updatedAt"),
  };
}

function parseAdminProgress(value: unknown): AdminProgressRecord {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned invalid admin progress.");
  }
  const lessonId = readString(value, "lessonId");
  const status = readString(value, "status");
  if (!isLessonSlug(lessonId)) {
    throw new RepositoryError("unavailable", "Supabase returned an unknown lesson.");
  }
  if (status !== "not_started" && status !== "in_progress" && status !== "completed") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid progress state.");
  }
  return {
    lessonId,
    lessonVersion: readSafeInteger(value, "lessonVersion", 1, 1_000_000),
    status,
    currentStep: readBoundedText(value, "currentStep", 1, 100),
    percentage: readSafeInteger(value, "percentage", 0, 100),
    completedAt: readNullableTimestamp(value, "completedAt"),
    updatedAt: readTimestamp(value, "updatedAt"),
  };
}

function parseAdminCompileDiagnostic(value: unknown): AdminCompileDiagnostic {
  if (!isRecord(value)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid compile diagnostic.");
  }
  const lessonId = readString(value, "lessonId");
  const state = readString(value, "state");
  const safeErrorCode = readNullableString(value, "safeErrorCode");
  if (!isLessonSlug(lessonId)) {
    throw new RepositoryError("unavailable", "Supabase returned an unknown lesson.");
  }
  if (state !== "queued" && state !== "running" && state !== "succeeded" && state !== "failed") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid compile state.");
  }
  if (safeErrorCode !== null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(safeErrorCode)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid safe error code.");
  }
  return {
    id: readUuid(value, "id"),
    userId: readUuid(value, "userId"),
    lessonId,
    lessonVersion: readSafeInteger(value, "lessonVersion", 1, 1_000_000),
    state,
    durationMs: readNullableSafeInteger(value, "durationMs", 0, 60_000),
    safeErrorCode,
    diagnosticSummary: readBoundedText(value, "diagnosticSummary", 0, 1_000),
    createdAt: readTimestamp(value, "createdAt"),
    finishedAt: readNullableTimestamp(value, "finishedAt"),
  };
}

function parseAdminAuditEntry(value: unknown): AdminAuditEntry {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid audit entry.");
  }
  const action = readBoundedText(value, "action", 2, 80);
  const targetType = readBoundedText(value, "targetType", 2, 40);
  if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(action)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid audit action.");
  }
  if (!/^[a-z][a-z0-9_.-]{1,39}$/.test(targetType)) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid audit target.");
  }
  const targetId = readNullableString(value, "targetId");
  if (targetId !== null && Array.from(targetId).length > 160) {
    throw new RepositoryError("unavailable", "Supabase returned an invalid audit target id.");
  }
  return {
    id: readSafeInteger(value, "id", 1, Number.MAX_SAFE_INTEGER),
    actorId: readNullableUuid(value, "actorId"),
    action,
    targetType,
    targetId,
    metadata: value.metadata,
    createdAt: readTimestamp(value, "createdAt"),
  };
}

function isExactProgressReplay(
  progress: LessonProgress | null,
  lessonId: string,
  input: ProgressUpdateInput,
): progress is LessonProgress {
  if (!progress) return false;
  const expectedRevision = (input.expectedRevision ?? 0) + 1;
  const expectedEvidence = input.status === "completed"
    ? input.uploadEvidenceId ?? null
    : null;
  const snapshotMatches = input.codeSnapshot === undefined
    ? input.expectedRevision !== null || progress.codeSnapshot === null
    : progress.codeSnapshot === input.codeSnapshot;
  return progress.lessonId === lessonId &&
    progress.lessonVersion === input.lessonVersion &&
    progress.revision === expectedRevision &&
    progress.status === input.status &&
    progress.currentStep === input.currentStep &&
    progress.percentage === input.percentage &&
    progress.completionEvidenceId === expectedEvidence &&
    snapshotMatches;
}

async function cancelBodyQuietly(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // A deadline or upstream failure may already have errored the stream.
  }
}

async function cancelReaderQuietly<T>(
  reader: ReadableStreamDefaultReader<T>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A deadline or upstream failure may already have errored the stream.
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) {
    await cancelBodyQuietly(response.body);
    throw new SupabaseRequestDeadlineError();
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_UPSTREAM_JSON_BYTES) {
    await cancelBodyQuietly(response.body);
    throw new RepositoryError("unavailable", "Supabase returned an oversized response.");
  }

  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    void cancelReaderQuietly(reader);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new RepositoryError("unavailable", "Supabase returned invalid response bytes.");
      }
      total += chunk.byteLength;
      if (total > MAX_UPSTREAM_JSON_BYTES) {
        await cancelReaderQuietly(reader);
        throw new RepositoryError("unavailable", "Supabase returned an oversized response.");
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RepositoryError("unavailable", "Supabase returned invalid JSON.");
  }
}

function parseSupabaseError(value: unknown): SupabaseErrorBody {
  if (!isRecord(value)) return { code: null, message: null };
  return {
    code: typeof value.code === "string" ? value.code : null,
    message:
      typeof value.message === "string"
        ? value.message
        : typeof value.msg === "string"
          ? value.msg
          : null,
  };
}

function mapUpstreamError(status: number, error: SupabaseErrorBody): RepositoryError {
  if (status === 401) return new RepositoryError("unauthorized", "Session rejected.", error.code);
  if (status === 403) return new RepositoryError("forbidden", "Operation forbidden.", error.code);
  if (status === 409) return new RepositoryError("conflict", "Data conflict.", error.code);
  if (status >= 400 && status < 500) {
    return new RepositoryError("invalid", "Supabase rejected the request.", error.code);
  }
  return new RepositoryError("unavailable", "Supabase is unavailable.", error.code);
}

class SupabaseIdentityRepository implements IdentityRepository {
  readonly #baseUrl: URL;
  readonly #publishableKey: string;
  readonly #serviceRoleKey: string;
  readonly #accessToken: string;
  readonly #accessTokenClaims: AccessTokenClaims | null;
  readonly #fetcher: RepositoryFetcher;
  readonly #requestTimeoutMs: number;

  constructor(
    env: Env,
    accessToken: string,
    fetcher: RepositoryFetcher,
    requestTimeoutMs: number,
  ) {
    const supabaseUrl = readConfiguredValue(env.SUPABASE_URL);
    const expectedProjectRef = readConfiguredValue(env.SUPABASE_PROJECT_REF);
    const publishableKey = readConfiguredValue(env.SUPABASE_PUBLISHABLE_KEY);
    const serviceRoleKey = readConfiguredValue(env.SUPABASE_SERVICE_ROLE_KEY);
    if (!supabaseUrl || !expectedProjectRef || !publishableKey || !serviceRoleKey) {
      throw new RepositoryError("unavailable", "Supabase is not configured.");
    }
    const environment = readConfiguredValue(env.ENVIRONMENT) ?? "";
    this.#baseUrl = configuredSupabaseUrl(
      supabaseUrl,
      environment,
      expectedProjectRef,
    );
    this.#accessTokenClaims = environment === "development"
      ? (() => {
          try {
            return parseSupabaseTokenClaims(accessToken, this.#baseUrl);
          } catch {
            return null;
          }
        })()
      : parseSupabaseTokenClaims(accessToken, this.#baseUrl);
    this.#publishableKey = publishableKey;
    this.#serviceRoleKey = serviceRoleKey;
    this.#accessToken = accessToken;
    this.#fetcher = fetcher;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 60_000
    ) {
      throw new RepositoryError("unavailable", "Supabase is not configured.");
    }
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async #request(
    path: string,
    init: RequestInit = {},
    privilege: "learner" | "service" = "learner",
  ): Promise<unknown> {
    const serviceRequest = privilege === "service";
    const apiKey = serviceRequest ? this.#serviceRoleKey : this.#publishableKey;
    const authorization = serviceRequest ? apiKey : this.#accessToken;
    const headers = new Headers(init.headers);
    headers.set("apikey", apiKey);
    headers.set("Authorization", `Bearer ${authorization}`);
    if (init.body) headers.set("Content-Type", "application/json");

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SupabaseRequestDeadlineError());
      }, this.#requestTimeoutMs);
    });

    try {
      const operation = (async (): Promise<unknown> => {
        let response: Response;
        try {
          response = await this.#fetcher(new URL(path, this.#baseUrl), {
            ...init,
            headers,
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) {
            throw new SupabaseRequestDeadlineError();
          }
          throw new RepositoryError("unavailable", "Supabase could not be reached.");
        }

        const body = await readBoundedJson(response, controller.signal);
        if (!response.ok) {
          throw mapUpstreamError(response.status, parseSupabaseError(body));
        }
        return body;
      })();

      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (error instanceof SupabaseRequestDeadlineError || controller.signal.aborted) {
        throw new RepositoryError("unavailable", "Supabase request timed out.");
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async #readCompleteExportRows<T extends object>(
    resource: string,
    maximumRecords: number,
    pageSize: number,
    budget: AccountExportSerializedBudget,
    parseRow: (value: unknown) => T,
  ): Promise<readonly T[]> {
    const rows: T[] = [];
    for (;;) {
      const remaining = maximumRecords + 1 - rows.length;
      const limit = Math.min(pageSize, remaining);
      const separator = resource.includes("?") ? "&" : "?";
      const body = await this.#request(
        `${resource}${separator}limit=${String(limit)}&offset=${String(rows.length)}`,
      );
      if (!isUnknownArray(body) || body.length > limit) {
        throw new RepositoryError("unavailable", "Supabase returned an invalid export page.");
      }
      for (const value of body) {
        const row = parseRow(value);
        if (rows.length >= maximumRecords) {
          throw new RepositoryError(
            "export_too_large",
            "The complete account export exceeds the supported record limit.",
          );
        }
        retainAccountExportRow(rows, row, budget);
      }
      if (body.length < limit) return rows;
    }
  }

  async authenticate(): Promise<AuthenticatedUser> {
    const body = await this.#request("/auth/v1/user");
    if (!isRecord(body)) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid user.");
    }

    const id = readString(body, "id");
    if (this.#accessTokenClaims?.subject && this.#accessTokenClaims.subject !== id) {
      throw new RepositoryError("unauthorized", "Session rejected.");
    }

    return {
      id,
      email: readString(body, "email"),
      emailConfirmed: typeof body.email_confirmed_at === "string",
      lastSignInAt: typeof body.last_sign_in_at === "string" ? body.last_sign_in_at : null,
      sessionId: this.#accessTokenClaims?.sessionId ?? null,
      isAnonymous: body.is_anonymous === true,
    };
  }

  async getBootstrap(userId: string): Promise<BootstrapRecords> {
    const idFilter = encodeURIComponent(`eq.${userId}`);
    const currentLessonFilter = encodeURIComponent(
      `(${curriculumLessons
        .map(
          (lesson) =>
            `and(lesson_id.eq.${lesson.id},lesson_version.eq.${String(lesson.version)})`,
        )
        .join(",")})`,
    );
    const [profileBody, kitBody, progressBody] = await Promise.all([
      this.#request(
        `/rest/v1/profiles?id=${idFilter}&select=id,display_name,role,access_source,access_granted_at,created_at,updated_at&limit=1`,
      ),
      this.#request(
        `/rest/v1/kit_codes?claimed_by=${idFilter}&kind=eq.code&state=eq.claimed&revoked_at=is.null&select=id,batch,kind,claimed_at&limit=1`,
        {},
        "service",
      ),
      this.#request(
        `/rest/v1/lesson_progress?user_id=${idFilter}&or=${currentLessonFilter}&select=lesson_id,lesson_version,revision,status,current_step,percentage,code_snapshot,completion_evidence_id,completed_at,updated_at&limit=${String(curriculumLessons.length)}`,
      ),
    ]);

    if (!Array.isArray(profileBody) || profileBody.length !== 1) {
      throw new RepositoryError("unavailable", "The learner profile is missing.");
    }
    if (!Array.isArray(kitBody) || !Array.isArray(progressBody)) {
      throw new RepositoryError("unavailable", "Supabase returned invalid bootstrap data.");
    }

    const profile = parseProfile(profileBody[0]);
    let activation: KitActivation | null = null;
    if (profile.accessSource === "grandfathered" && profile.accessGrantedAt) {
      activation = {
        id: profile.id,
        batch: "legacy-pilot",
        kind: "grandfathered",
        claimedAt: profile.accessGrantedAt,
      };
    } else if (profile.accessSource === "code") {
      if (kitBody.length === 1) activation = parseActivation(kitBody[0]);
    }

    return {
      profile,
      activation,
      progress: progressBody.map((row) => parseProgress(row)),
    };
  }

  async getAccountExport(userId: string): Promise<AccountExportRecords> {
    const idFilter = encodeURIComponent(`eq.${userId}`);
    const [profileBody, activationBody] = await Promise.all([
      this.#request(
        `/rest/v1/profiles?id=${idFilter}&select=id,display_name,role,access_source,access_granted_at,created_at,updated_at&limit=2`,
      ),
      this.#request(
        "/rest/v1/kit_codes?select=id,batch,kind,claimed_at&order=claimed_at.desc,id.desc&limit=2",
      ),
    ]);

    if (!Array.isArray(profileBody) || profileBody.length !== 1) {
      throw new RepositoryError("unavailable", "The learner profile is missing.");
    }
    if (!Array.isArray(activationBody) || activationBody.length > 1) {
      throw new RepositoryError("unavailable", "Supabase returned invalid activation data.");
    }
    const profile = parseProfile(profileBody[0]);
    if (profile.id !== userId) {
      throw new RepositoryError("unavailable", "Supabase returned another owner's profile.");
    }

    let activation: KitActivation | null = null;
    if (profile.accessSource === "grandfathered" && profile.accessGrantedAt !== null) {
      if (activationBody.length !== 0) {
        throw new RepositoryError("unavailable", "Supabase returned inconsistent activation data.");
      }
      activation = {
        id: profile.id,
        batch: "legacy-pilot",
        kind: "grandfathered",
        claimedAt: profile.accessGrantedAt,
      };
    } else if (profile.accessSource === "code") {
      if (activationBody.length !== 1) {
        throw new RepositoryError("unavailable", "The learner activation is missing.");
      }
      activation = parseActivation(activationBody[0]);
    } else if (activationBody.length !== 0) {
      throw new RepositoryError("unavailable", "Supabase returned inconsistent activation data.");
    }

    const budget = createAccountExportSerializedBudget(profile, activation);
    const progress = await this.#readCompleteExportRows(
      `/rest/v1/lesson_progress?user_id=${idFilter}&select=${ACCOUNT_EXPORT_PROGRESS_SELECT}&order=lesson_id.asc,lesson_version.asc`,
      ACCOUNT_EXPORT_MAX_PROGRESS_RECORDS,
      ACCOUNT_EXPORT_PROGRESS_PAGE_SIZE,
      budget,
      (row) => parseAccountExportProgress(row, userId),
    );
    const compileJobs = await this.#readCompleteExportRows(
      `/rest/v1/compile_jobs?user_id=${idFilter}&select=${ACCOUNT_EXPORT_COMPILE_SELECT}&order=created_at.asc,id.asc`,
      ACCOUNT_EXPORT_MAX_COMPILE_JOBS,
      ACCOUNT_EXPORT_COMPILE_PAGE_SIZE,
      budget,
      (row) => parseAccountExportCompileJob(row, userId),
    );
    const uploadEvidence = await this.#readCompleteExportRows(
      `/rest/v1/hardware_upload_evidence?user_id=${idFilter}&select=${ACCOUNT_EXPORT_UPLOAD_SELECT}&order=recorded_at.asc,id.asc`,
      ACCOUNT_EXPORT_MAX_UPLOAD_EVIDENCE,
      ACCOUNT_EXPORT_UPLOAD_PAGE_SIZE,
      budget,
      (row) => parseAccountExportUploadEvidence(row, userId),
    );

    return {
      profile,
      activation,
      progress,
      compileJobs,
      uploadEvidence,
    };
  }

  async updateProfile(userId: string, displayName: string): Promise<ProfileRecord> {
    const idFilter = encodeURIComponent(`eq.${userId}`);
    const body = await this.#request(
      `/rest/v1/profiles?id=${idFilter}&select=id,display_name,role,access_source,access_granted_at,created_at,updated_at`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ display_name: displayName }),
      },
    );

    if (!Array.isArray(body) || body.length !== 1) {
      throw new RepositoryError("unavailable", "Supabase did not return the updated profile.");
    }
    return parseProfile(body[0]);
  }

  async claimKit(userId: string, codeHash: string): Promise<KitActivation> {
    const body = await this.#request(
      "/rest/v1/rpc/claim_kit_code",
      {
        method: "POST",
        body: JSON.stringify({ p_user_id: userId, p_code_hash: codeHash }),
      },
      "service",
    );

    if (!isRecord(body)) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid claim result.");
    }
    const result = body.result;
    if (result === "invalid") {
      throw new RepositoryError("kit_invalid", "Kit code is invalid or unavailable.");
    }
    if ((result !== "claimed" && result !== "already_active") || !("activation" in body)) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid claim result.");
    }

    const rawActivation = body.activation;
    if (!isRecord(rawActivation)) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid activation.");
    }
    return parseActivation({
      id: rawActivation.id,
      batch: rawActivation.batch,
      kind: rawActivation.kind,
      claimed_at: rawActivation.claimedAt,
    });
  }

  async hasActivation(userId: string): Promise<boolean> {
    const idFilter = encodeURIComponent(`eq.${userId}`);
    const profileBody = await this.#request(
      `/rest/v1/profiles?id=${idFilter}&select=access_source&limit=1`,
    );
    if (!Array.isArray(profileBody) || profileBody.length !== 1 || !isRecord(profileBody[0])) {
      throw new RepositoryError("unavailable", "The learner profile is missing.");
    }
    const source = profileBody[0].access_source;
    if (source === "grandfathered") return true;
    if (source !== "code") return false;

    const kitBody = await this.#request(
      `/rest/v1/kit_codes?claimed_by=${idFilter}&kind=eq.code&state=eq.claimed&revoked_at=is.null&select=id&limit=1`,
      {},
      "service",
    );
    if (!Array.isArray(kitBody) || kitBody.length > 1) {
      throw new RepositoryError("unavailable", "Supabase returned invalid kit access.");
    }
    return kitBody.length === 1;
  }

  async beginCompileJob(
    userId: string,
    input: BeginCompileJobInput,
  ): Promise<CompileJobGate> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_begin_compile_job",
      {
        method: "POST",
        body: JSON.stringify({
          p_user_id: userId,
          p_lesson_id: input.lessonId,
          p_lesson_version: input.lessonVersion,
          p_source_hash: input.sourceHash,
          p_board_target: FIRELIGHT_BOARD_FQBN,
        }),
      },
      "service",
    );
    if (!isRecord(body) || typeof body.result !== "string") {
      throw new RepositoryError("unavailable", "Supabase returned an invalid compile gate.");
    }
    if (body.result === "started") {
      return { result: "started", jobId: readUuid(body, "jobId") };
    }
    if (body.result === "active") return { result: "active" };
    if (body.result === "not_entitled") return { result: "not_entitled" };
    if (body.result === "rate_limited") {
      const scope = body.scope;
      const retryAfterSeconds = body.retryAfterSeconds;
      if (
        (scope !== "hour" && scope !== "day") ||
        !Number.isInteger(retryAfterSeconds) ||
        Number(retryAfterSeconds) < 1 ||
        Number(retryAfterSeconds) > 86_400
      ) {
        throw new RepositoryError("unavailable", "Supabase returned an invalid rate limit.");
      }
      return {
        result: "rate_limited",
        scope,
        retryAfterSeconds: Number(retryAfterSeconds),
      };
    }
    if (body.result === "invalid") {
      throw new RepositoryError("invalid", "The compile job was rejected.");
    }
    throw new RepositoryError("unavailable", "Supabase returned an invalid compile gate.");
  }

  async finishCompileJob(userId: string, input: FinishCompileJobInput): Promise<void> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_finish_compile_job",
      {
        method: "POST",
        body: JSON.stringify({
          p_user_id: userId,
          p_job_id: input.jobId,
          p_terminal_state: input.state,
          p_duration_ms: input.durationMs,
          p_safe_error_code: input.safeErrorCode,
          p_artifact_hash: input.artifactHash,
          p_diagnostic_summary: input.diagnosticSummary,
        }),
      },
      "service",
    );
    if (!isRecord(body) || body.result !== "finished") {
      if (isRecord(body) && body.result === "not_entitled") {
        throw new RepositoryError("forbidden", "Kit access is no longer active.");
      }
      if (isRecord(body) && body.result === "conflict") {
        throw new RepositoryError("conflict", "Compile job state changed.");
      }
      if (isRecord(body) && body.result === "invalid") {
        throw new RepositoryError("invalid", "Compile job completion was rejected.");
      }
      throw new RepositoryError("unavailable", "Supabase returned an invalid compile result.");
    }
  }

  async recordUploadEvidence(
    userId: string,
    compileJobId: string,
    artifactHash: string,
    bytesWritten: number,
  ): Promise<UploadEvidence> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_record_upload_evidence",
      {
        method: "POST",
        body: JSON.stringify({
          p_user_id: userId,
          p_compile_job_id: compileJobId,
          p_artifact_hash: artifactHash,
          p_bytes_written: bytesWritten,
        }),
      },
      "service",
    );
    if (!isRecord(body) || body.result !== "recorded" || !isRecord(body.evidence)) {
      if (isRecord(body) && body.result === "not_entitled") {
        throw new RepositoryError("forbidden", "Kit access is no longer active.");
      }
      if (isRecord(body) && body.result === "invalid") {
        throw new RepositoryError("invalid", "Upload evidence did not match a compile job.");
      }
      throw new RepositoryError("unavailable", "Supabase returned invalid upload evidence.");
    }
    const evidence = body.evidence;
    const lessonId = readString(evidence, "lessonId");
    const lessonVersion = evidence.lessonVersion;
    const bytes = evidence.bytesWritten;
    const attestation = readString(evidence, "attestation");
    const id = readUuidV4(evidence, "id");
    const responseCompileJobId = readUuidV4(evidence, "compileJobId");
    const sourceHash = readSha256(evidence, "sourceHash");
    const responseArtifactHash = readSha256(evidence, "artifactHash");
    const recordedAt = readTimestamp(evidence, "recordedAt");
    if (
      !isLessonSlug(lessonId) ||
      !Number.isSafeInteger(lessonVersion) ||
      Number(lessonVersion) < 1 ||
      !Number.isInteger(bytes) ||
      Number(bytes) < 1 ||
      Number(bytes) > MAX_NANO_UPLOAD_BYTES ||
      attestation !== "browser-web-serial-v1" ||
      responseCompileJobId !== compileJobId ||
      responseArtifactHash !== artifactHash ||
      Number(bytes) !== bytesWritten
    ) {
      throw new RepositoryError("unavailable", "Supabase returned invalid upload evidence.");
    }
    return {
      id,
      compileJobId: responseCompileJobId,
      lessonId,
      lessonVersion: Number(lessonVersion),
      sourceHash,
      artifactHash: responseArtifactHash,
      bytesWritten: Number(bytes),
      recordedAt,
      attestation,
    };
  }

  async #readProgress(
    userId: string,
    lessonId: string,
    lessonVersion: number,
  ): Promise<LessonProgress | null> {
    const resource =
      `/rest/v1/lesson_progress?user_id=${encodeURIComponent(`eq.${userId}`)}` +
      `&lesson_id=${encodeURIComponent(`eq.${lessonId}`)}` +
      `&lesson_version=${encodeURIComponent(`eq.${String(lessonVersion)}`)}` +
      `&select=${PROGRESS_SELECT}&limit=1`;
    return parseSavedProgress(await this.#request(resource));
  }

  async upsertProgress(
    userId: string,
    lessonId: string,
    input: ProgressUpdateInput,
  ): Promise<LessonProgress> {
    const progressValues: Record<string, unknown> = {
      status: input.status,
      current_step: input.currentStep,
      percentage: input.percentage,
      completed_at: null,
      revision: input.expectedRevision === null ? 1 : input.expectedRevision + 1,
      completion_evidence_id:
        input.status === "completed" ? input.uploadEvidenceId ?? null : null,
    };
    const progressRecord: Record<string, unknown> = {
      user_id: userId,
      lesson_id: lessonId,
      lesson_version: input.lessonVersion,
      ...progressValues,
    };
    if (input.codeSnapshot !== undefined) progressRecord.code_snapshot = input.codeSnapshot;

    if (input.expectedRevision === null) {
      let inserted: LessonProgress | null;
      try {
        inserted = parseSavedProgress(
          await this.#request(`/rest/v1/lesson_progress?select=${PROGRESS_SELECT}`, {
            method: "POST",
            headers: { Prefer: "return=representation,missing=default" },
            body: JSON.stringify(progressRecord),
          }, "service"),
        );
      } catch (error) {
        if (
          !(error instanceof RepositoryError) ||
          (error.kind !== "conflict" && error.kind !== "unavailable")
        ) {
          throw error;
        }
        const replay = await this.#readProgress(userId, lessonId, input.lessonVersion);
        if (isExactProgressReplay(replay, lessonId, input)) return replay;
        throw error;
      }
      if (inserted) return inserted;
      const replay = await this.#readProgress(userId, lessonId, input.lessonVersion);
      if (isExactProgressReplay(replay, lessonId, input)) return replay;
      throw new RepositoryError("unavailable", "Supabase did not return saved progress.");
    }

    const resource = `/rest/v1/lesson_progress?user_id=${encodeURIComponent(`eq.${userId}`)}&lesson_id=${encodeURIComponent(`eq.${lessonId}`)}&lesson_version=${encodeURIComponent(`eq.${String(input.lessonVersion)}`)}&revision=${encodeURIComponent(`eq.${String(input.expectedRevision)}`)}&select=${PROGRESS_SELECT}`;
    const saved = parseSavedProgress(
      await this.#request(resource, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(
          input.codeSnapshot === undefined
            ? progressValues
            : { ...progressValues, code_snapshot: input.codeSnapshot },
        ),
      }, "service"),
    );
    if (saved) return saved;
    const replay = await this.#readProgress(userId, lessonId, input.lessonVersion);
    if (isExactProgressReplay(replay, lessonId, input)) return replay;
    throw new RepositoryError("conflict", "Lesson progress revision changed.");
  }

  async isAdmin(userId: string): Promise<boolean> {
    const idFilter = encodeURIComponent(`eq.${userId}`);
    const body = await this.#request(
      `/rest/v1/profiles?id=${idFilter}&select=role&limit=1`,
    );
    if (!Array.isArray(body) || body.length > 1) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid role result.");
    }
    if (body.length === 0) return false;
    if (!isRecord(body[0])) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid role result.");
    }
    const role = readString(body[0], "role");
    if (role !== "learner" && role !== "admin") {
      throw new RepositoryError("unavailable", "Supabase returned an invalid role result.");
    }
    return role === "admin";
  }

  async createAdminKitBatch(
    actorId: string,
    batch: string,
    codeIds: readonly string[],
    codeHashes: readonly string[],
  ): Promise<AdminKitBatchCreationResult> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_admin_create_kit_batch",
      {
        method: "POST",
        body: JSON.stringify({
          p_actor_id: actorId,
          p_batch: batch,
          p_code_ids: codeIds,
          p_code_hashes: codeHashes,
        }),
      },
      "service",
    );
    if (
      !isRecord(body) ||
      body.result !== "created" ||
      readString(body, "batch") !== batch ||
      readSafeInteger(body, "count", 1, 100) !== codeHashes.length ||
      codeIds.length !== codeHashes.length
    ) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid batch result.");
    }
    return {
      batch,
      count: codeHashes.length,
      createdAt: readTimestamp(body, "createdAt"),
    };
  }

  async listAdminKits(
    actorId: string,
    query: string,
    state: AdminKitCodeState | null,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminKitRecord>> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_admin_list_kits",
      {
        method: "POST",
        body: JSON.stringify({
          p_actor_id: actorId,
          p_query: query,
          p_state: state,
          p_limit: page.limit,
          p_offset: page.offset,
        }),
      },
      "service",
    );
    return parseAdminPage(body, page, parseAdminKit);
  }

  async revokeAdminKit(
    actorId: string,
    kitId: string,
    reason: AdminKitRevocationInput["reason"],
  ): Promise<AdminKitRevocationResult | null> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_admin_revoke_kit",
      {
        method: "POST",
        body: JSON.stringify({
          p_actor_id: actorId,
          p_kit_id: kitId,
          p_reason: reason,
        }),
      },
      "service",
    );
    if (!isRecord(body) || typeof body.result !== "string") {
      throw new RepositoryError("unavailable", "Supabase returned an invalid revocation result.");
    }
    if (body.result === "not_found") return null;
    if (body.result !== "revoked" && body.result !== "already_revoked") {
      throw new RepositoryError("unavailable", "Supabase returned an invalid revocation result.");
    }
    const id = readUuid(body, "id");
    if (id !== kitId || typeof body.accessRevoked !== "boolean") {
      throw new RepositoryError("unavailable", "Supabase returned an invalid revocation result.");
    }
    return {
      id,
      state: body.result,
      accessRevoked: body.accessRevoked,
    };
  }

  async listAdminLearners(
    actorId: string,
    query: string,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminLearnerSummary>> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_admin_list_learners",
      {
        method: "POST",
        body: JSON.stringify({
          p_actor_id: actorId,
          p_query: query,
          p_limit: page.limit,
          p_offset: page.offset,
        }),
      },
      "service",
    );
    return parseAdminPage(body, page, parseAdminLearner);
  }

  async listAdminProgress(
    actorId: string,
    learnerId: string,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminProgressRecord>> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_admin_list_progress",
      {
        method: "POST",
        body: JSON.stringify({
          p_actor_id: actorId,
          p_user_id: learnerId,
          p_limit: page.limit,
          p_offset: page.offset,
        }),
      },
      "service",
    );
    return parseAdminPage(body, page, parseAdminProgress);
  }

  async listAdminCompileDiagnostics(
    actorId: string,
    state: AdminCompileState | null,
    errorCode: string | null,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminCompileDiagnostic>> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_admin_list_compile_jobs",
      {
        method: "POST",
        body: JSON.stringify({
          p_actor_id: actorId,
          p_state: state,
          p_error_code: errorCode,
          p_limit: page.limit,
          p_offset: page.offset,
        }),
      },
      "service",
    );
    return parseAdminPage(body, page, parseAdminCompileDiagnostic);
  }

  async listAdminAudit(
    actorId: string,
    action: string | null,
    page: AdminPageInput,
  ): Promise<AdminPage<AdminAuditEntry>> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_admin_list_audit",
      {
        method: "POST",
        body: JSON.stringify({
          p_actor_id: actorId,
          p_action: action,
          p_limit: page.limit,
          p_offset: page.offset,
        }),
      },
      "service",
    );
    return parseAdminPage(body, page, parseAdminAuditEntry);
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.#request(
      `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      "service",
    );
  }

  async hasRecentSession(userId: string, sessionId: string): Promise<boolean> {
    const body = await this.#request(
      "/rest/v1/rpc/firelight_has_recent_session",
      {
        method: "POST",
        body: JSON.stringify({
          p_user_id: userId,
          p_session_id: sessionId,
          p_max_age_seconds: 900,
        }),
      },
      "service",
    );
    if (typeof body !== "boolean") {
      throw new RepositoryError("unavailable", "Supabase returned invalid session freshness.");
    }
    return body;
  }
}

export function createSupabaseIdentityRepository(
  env: Env,
  accessToken: string,
  fetcher: RepositoryFetcher = (input, init) => fetch(input, init),
  requestTimeoutMs = SUPABASE_REQUEST_TIMEOUT_MS,
): IdentityRepository {
  return new SupabaseIdentityRepository(
    env,
    accessToken,
    fetcher,
    requestTimeoutMs,
  );
}
