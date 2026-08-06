import type {
  KitActivation,
  KitActivationKind,
  LessonProgress,
  ProfileRole,
  ProgressUpdateInput,
} from "../shared/identity";
import { curriculumLessons, isLessonSlug } from "../shared/curriculum";

const MAX_UPSTREAM_JSON_BYTES = 3 * 1024 * 1024;

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailConfirmed: boolean;
  readonly lastSignInAt: string | null;
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
  const percentage = value.percentage;
  if (!isLessonSlug(lessonId)) {
    throw new RepositoryError("unavailable", "Supabase returned an unknown lesson.");
  }
  if (status !== "not_started" && status !== "in_progress" && status !== "completed") {
    throw new RepositoryError("unavailable", "Supabase returned an invalid progress status.");
  }
  if (!Number.isInteger(lessonVersion) || !Number.isInteger(percentage)) {
    throw new RepositoryError("unavailable", "Supabase returned invalid progress numbers.");
  }

  return {
    lessonId,
    lessonVersion: Number(lessonVersion),
    status,
    currentStep: readString(value, "current_step"),
    percentage: Number(percentage),
    codeSnapshot: readNullableString(value, "code_snapshot"),
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

  constructor(env: Env, accessToken: string) {
    const supabaseUrl = readConfiguredValue(env.SUPABASE_URL);
    const publishableKey = readConfiguredValue(env.SUPABASE_PUBLISHABLE_KEY);
    const serviceRoleKey = readConfiguredValue(env.SUPABASE_SERVICE_ROLE_KEY);
    if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
      throw new RepositoryError("unavailable", "Supabase is not configured.");
    }
    try {
      this.#baseUrl = new URL(supabaseUrl);
    } catch {
      throw new RepositoryError("unavailable", "Supabase is not configured.");
    }
    this.#publishableKey = publishableKey;
    this.#serviceRoleKey = serviceRoleKey;
    this.#accessToken = accessToken;
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
      response = await fetch(new URL(path, this.#baseUrl), {
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
        `/rest/v1/kit_codes?claimed_by=${idFilter}&state=eq.claimed&select=id,batch,kind,claimed_at&limit=1`,
        {},
        "service",
      ),
      this.#request(
        `/rest/v1/lesson_progress?user_id=${idFilter}&or=${currentLessonFilter}&select=lesson_id,lesson_version,status,current_step,percentage,code_snapshot,completed_at,updated_at&limit=${String(curriculumLessons.length)}`,
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
      if (kitBody.length !== 1) {
        throw new RepositoryError("unavailable", "The kit activation is inconsistent.");
      }
      activation = parseActivation(kitBody[0]);
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
    const body = await this.#request(
      `/rest/v1/profiles?id=${idFilter}&select=access_source&limit=1`,
    );
    if (!Array.isArray(body) || body.length !== 1 || !isRecord(body[0])) {
      throw new RepositoryError("unavailable", "The learner profile is missing.");
    }
    const source = body[0].access_source;
    return source === "code" || source === "grandfathered";
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
    };
    const progressRecord: Record<string, unknown> = {
      user_id: userId,
      lesson_id: lessonId,
      lesson_version: input.lessonVersion,
      ...progressValues,
    };
    if (input.codeSnapshot !== undefined) {
      progressRecord.code_snapshot = input.codeSnapshot;
      const body = await this.#request(
        "/rest/v1/lesson_progress?on_conflict=user_id,lesson_id,lesson_version&select=lesson_id,lesson_version,status,current_step,percentage,code_snapshot,completed_at,updated_at",
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(progressRecord),
        },
      );
      const saved = parseSavedProgress(body);
      if (!saved) {
        throw new RepositoryError("unavailable", "Supabase did not return saved progress.");
      }
      return saved;
    }

    const select =
      "lesson_id,lesson_version,status,current_step,percentage,code_snapshot,completed_at,updated_at";
    const resource = `/rest/v1/lesson_progress?user_id=${encodeURIComponent(`eq.${userId}`)}&lesson_id=${encodeURIComponent(`eq.${lessonId}`)}&lesson_version=${encodeURIComponent(`eq.${String(input.lessonVersion)}`)}&select=${select}`;
    const patchWithoutSnapshot = async () =>
      parseSavedProgress(
        await this.#request(resource, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(progressValues),
        }),
      );

    const existing = await patchWithoutSnapshot();
    if (existing) return existing;

    try {
      const inserted = parseSavedProgress(
        await this.#request(
          `/rest/v1/lesson_progress?select=${select}`,
          {
            method: "POST",
            headers: { Prefer: "return=representation,missing=default" },
            body: JSON.stringify(progressRecord),
          },
        ),
      );
      if (inserted) return inserted;
    } catch (error) {
      if (!(error instanceof RepositoryError) || error.kind !== "conflict") throw error;
      const concurrentlyInserted = await patchWithoutSnapshot();
      if (concurrentlyInserted) return concurrentlyInserted;
    }

    throw new RepositoryError("unavailable", "Supabase did not return saved progress.");
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.#request(
      `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      "service",
    );
  }
}

export const createSupabaseIdentityRepository: IdentityRepositoryFactory = (
  env,
  accessToken,
) => new SupabaseIdentityRepository(env, accessToken);
