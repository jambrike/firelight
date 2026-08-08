import type {
  KitActivation,
  KitActivationKind,
  LessonProgress,
  ProfileRole,
  ProgressUpdateInput,
} from "../shared/identity";
import { curriculumLessons, isLessonSlug } from "../shared/curriculum";
import {
  FIRELIGHT_BOARD_FQBN,
  isRfc3339Timestamp,
  MAX_NANO_UPLOAD_BYTES,
  type UploadEvidence,
} from "../shared/hardware";

const MAX_UPSTREAM_JSON_BYTES = 3 * 1024 * 1024;
const PROGRESS_SELECT =
  "lesson_id,lesson_version,revision,status,current_step,percentage,code_snapshot,completion_evidence_id,completed_at,updated_at";

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailConfirmed: boolean;
  readonly lastSignInAt: string | null;
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

export type RepositoryErrorKind =
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "kit_invalid"
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
  deleteAccount(userId: string): Promise<void>;
}

export type IdentityRepositoryFactory = (
  env: Env,
  accessToken: string,
) => IdentityRepository;

export type RepositoryFetcher = (
  input: URL,
  init: RequestInit,
) => Promise<Response>;

interface SupabaseErrorBody {
  readonly code: string | null;
  readonly message: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfiguredValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configuredSupabaseUrl(value: string, environment: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RepositoryError("unavailable", "Supabase is not configured.");
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const isDevelopmentLoopback =
    environment === "development" &&
    isLoopback &&
    parsed.protocol === "http:" &&
    parsed.port.length > 0;
  const isHostedProject =
    parsed.protocol === "https:" &&
    /^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname) &&
    parsed.port.length === 0;
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

function validateSupabaseTokenIssuer(accessToken: string, baseUrl: URL): void {
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
    if (
      !isRecord(payload) ||
      payload.iss !== `${baseUrl.origin}/auth/v1`
    ) {
      throw new Error("issuer mismatch");
    }
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
    id: readString(value, "id"),
    displayName: readString(value, "display_name"),
    role,
    accessSource,
    accessGrantedAt: readNullableString(value, "access_granted_at"),
    createdAt: readString(value, "created_at"),
    updatedAt: readString(value, "updated_at"),
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
    id: readString(value, "id"),
    batch: readString(value, "batch"),
    kind,
    claimedAt: readString(value, "claimed_at"),
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
  if (!isLessonSlug(lessonId)) {
    throw new RepositoryError("unavailable", "Supabase returned an unknown lesson.");
  }
  if (status !== "not_started" && status !== "in_progress" && status !== "completed") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid progress status.");
  }
  if (
    !Number.isInteger(lessonVersion) ||
    !Number.isInteger(revision) ||
    Number(revision) < 1 ||
    !Number.isInteger(percentage)
  ) {
    throw new RepositoryError("unavailable", "Supabase returned invalid progress numbers.");
  }

  return {
    lessonId,
    lessonVersion: Number(lessonVersion),
    revision: Number(revision),
    status,
    currentStep: readString(value, "current_step"),
    percentage: Number(percentage),
    codeSnapshot: readNullableString(value, "code_snapshot"),
    completionEvidenceId: readNullableUuid(value, "completion_evidence_id"),
    completedAt: readNullableString(value, "completed_at"),
    updatedAt: readString(value, "updated_at"),
  };
}

function parseSavedProgress(value: unknown): LessonProgress | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new RepositoryError("unavailable", "Supabase did not return valid saved progress.");
  }
  return value.length === 1 ? parseProgress(value[0]) : null;
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

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_UPSTREAM_JSON_BYTES) {
    throw new RepositoryError("unavailable", "Supabase returned an oversized response.");
  }

  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

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
        await reader.cancel();
        throw new RepositoryError("unavailable", "Supabase returned an oversized response.");
      }
      chunks.push(chunk);
    }
  } finally {
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
  readonly #fetcher: RepositoryFetcher;

  constructor(env: Env, accessToken: string, fetcher: RepositoryFetcher) {
    const supabaseUrl = readConfiguredValue(env.SUPABASE_URL);
    const publishableKey = readConfiguredValue(env.SUPABASE_PUBLISHABLE_KEY);
    const serviceRoleKey = readConfiguredValue(env.SUPABASE_SERVICE_ROLE_KEY);
    if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
      throw new RepositoryError("unavailable", "Supabase is not configured.");
    }
    const environment = readConfiguredValue(env.ENVIRONMENT) ?? "";
    this.#baseUrl = configuredSupabaseUrl(supabaseUrl, environment);
    if (environment !== "development") {
      validateSupabaseTokenIssuer(accessToken, this.#baseUrl);
    }
    this.#publishableKey = publishableKey;
    this.#serviceRoleKey = serviceRoleKey;
    this.#accessToken = accessToken;
    this.#fetcher = fetcher;
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

    let response: Response;
    try {
      response = await this.#fetcher(new URL(path, this.#baseUrl), {
        ...init,
        headers,
      });
    } catch {
      throw new RepositoryError("unavailable", "Supabase could not be reached.");
    }

    const body = await readBoundedJson(response);
    if (!response.ok) {
      throw mapUpstreamError(response.status, parseSupabaseError(body));
    }
    return body;
  }

  async authenticate(): Promise<AuthenticatedUser> {
    const body = await this.#request("/auth/v1/user");
    if (!isRecord(body)) {
      throw new RepositoryError("unavailable", "Supabase returned an invalid user.");
    }

    return {
      id: readString(body, "id"),
      email: readString(body, "email"),
      emailConfirmed: typeof body.email_confirmed_at === "string",
      lastSignInAt: typeof body.last_sign_in_at === "string" ? body.last_sign_in_at : null,
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
          }),
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
      }),
    );
    if (saved) return saved;
    const replay = await this.#readProgress(userId, lessonId, input.lessonVersion);
    if (isExactProgressReplay(replay, lessonId, input)) return replay;
    throw new RepositoryError("conflict", "Lesson progress revision changed.");
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.#request(
      `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      "service",
    );
  }
}

export function createSupabaseIdentityRepository(
  env: Env,
  accessToken: string,
  fetcher: RepositoryFetcher = fetch,
): IdentityRepository {
  return new SupabaseIdentityRepository(env, accessToken, fetcher);
}
