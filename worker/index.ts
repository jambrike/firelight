import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { curriculumLessons, findCurriculumLesson } from "../shared/curriculum";
import type {
  Achievement,
  BootstrapData,
  LearnerProfile,
  LessonProgress,
  ProgressUpdateInput,
} from "../shared/identity";
import {
  FIRELIGHT_BOARD_FQBN,
  MAX_NANO_UPLOAD_BYTES,
  MAX_SKETCH_SOURCE_BYTES,
} from "../shared/hardware";
import type {
  CompileSketchInput,
  UploadEvidenceInput,
} from "../shared/hardware";
import { findLesson } from "../src/features/lessons/catalog";
import type { LessonCatalogEntry } from "../src/features/lessons/catalog";
import { validateLessonCode } from "../src/features/lessons/code-validation";
import {
  CompilerGatewayError,
  diagnosticSummary,
  requestCompilation,
  sha256Hex,
} from "./compiler-gateway";
import type { CompilerFetcher } from "./compiler-gateway";
import {
  createSupabaseIdentityRepository,
  RepositoryError,
} from "./identity-repository";
import type {
  AuthenticatedUser,
  IdentityRepository,
  IdentityRepositoryFactory,
  ProfileRecord,
} from "./identity-repository";

interface FirelightWorker {
  Bindings: Env;
  Variables: {
    requestId: string;
    repository: IdentityRepository;
    user: AuthenticatedUser;
  };
}

interface AppDependencies {
  readonly createRepository?: IdentityRepositoryFactory;
  readonly compilerFetcher?: CompilerFetcher;
}

type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504;

class ApiRequestError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;

  constructor(status: ErrorStatus, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co http://127.0.0.1:54321 ws://127.0.0.1:54321; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=(), serial=(self)",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function applyResponseHeaders(context: Context<FirelightWorker>): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    context.header(name, value);
  }

  if (isApiPath(context.req.path)) {
    context.header("Cache-Control", "no-store");
  }
}

function apiError(
  context: Context<FirelightWorker>,
  status: ErrorStatus,
  code: string,
  message: string,
) {
  return context.json(
    {
      error: {
        code,
        message,
        requestId: context.get("requestId"),
      },
    },
    status,
  );
}

function toLearnerProfile(user: AuthenticatedUser, profile: ProfileRecord): LearnerProfile {
  return {
    id: profile.id,
    displayName: profile.displayName,
    role: profile.role,
    email: user.email,
    emailConfirmed: user.emailConfirmed,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function buildAchievements(completedIds: ReadonlySet<string>): readonly Achievement[] {
  return [
    {
      id: "first-upload",
      label: "First Upload",
      earned: completedIds.has("first-spark"),
    },
    {
      id: "name-signal",
      label: "Name Signal",
      earned: completedIds.has("morse-name"),
    },
    {
      id: "trail-complete",
      label: "Trail Complete",
      earned: curriculumLessons.every((lesson) => completedIds.has(lesson.id)),
    },
  ];
}

function buildBootstrap(
  user: AuthenticatedUser,
  records: Awaited<ReturnType<IdentityRepository["getBootstrap"]>>,
): BootstrapData {
  const currentCompleted = new Set(
    records.progress
      .filter((progress) => {
        const lesson = findCurriculumLesson(progress.lessonId);
        return progress.status === "completed" && lesson?.version === progress.lessonVersion;
      })
      .map((progress) => progress.lessonId),
  );
  const next = curriculumLessons.find((lesson) => !currentCompleted.has(lesson.id));

  return {
    profile: toLearnerProfile(user, records.profile),
    activation: records.activation,
    progress: records.progress,
    achievements: buildAchievements(currentCompleted),
    nextLesson: next ? { id: next.id, title: next.title } : null,
  };
}

function mapRepositoryError(error: RepositoryError): ApiRequestError {
  switch (error.kind) {
    case "unauthorized":
      return new ApiRequestError(401, "SESSION_INVALID", "Sign in again to continue.");
    case "forbidden":
      return new ApiRequestError(403, "FORBIDDEN", "This account cannot perform that action.");
    case "conflict":
      return new ApiRequestError(409, "CONFLICT", "The request conflicts with saved data.");
    case "kit_invalid":
      return new ApiRequestError(
        400,
        "KIT_CODE_UNAVAILABLE",
        "That kit code is invalid or unavailable.",
      );
    case "invalid":
      return new ApiRequestError(422, "DATA_REJECTED", "The saved data was rejected.");
    case "unavailable":
      return new ApiRequestError(
        503,
        "IDENTITY_SERVICE_UNAVAILABLE",
        "Account services are temporarily unavailable.",
      );
  }
}

async function readJsonBody(context: Context<FirelightWorker>, maxBytes: number): Promise<unknown> {
  const contentType = context.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiRequestError(415, "JSON_REQUIRED", "Send this request as JSON.");
  }

  const declaredLength = context.req.header("Content-Length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new ApiRequestError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  }

  const body = context.req.raw.body;
  if (!body) {
    throw new ApiRequestError(400, "INVALID_JSON", "A JSON body is required.");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new ApiRequestError(400, "INVALID_BODY", "The request body is invalid.");
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiRequestError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
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

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiRequestError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRuntimeString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true;
    }
  }
  return false;
}

function parseDisplayName(value: unknown): string {
  if (!isRecord(value) || typeof value.displayName !== "string") {
    throw new ApiRequestError(422, "DISPLAY_NAME_REQUIRED", "Enter a builder name.");
  }
  const displayName = value.displayName.trim();
  if (Array.from(displayName).length < 1 || Array.from(displayName).length > 40) {
    throw new ApiRequestError(
      422,
      "DISPLAY_NAME_INVALID",
      "Builder names must contain 1 to 40 characters.",
    );
  }
  return displayName;
}

const CROCKFORD_CODE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function normalizeKitCode(value: unknown): string {
  if (!isRecord(value) || typeof value.code !== "string") {
    throw new ApiRequestError(422, "KIT_CODE_REQUIRED", "Enter the code from your kit.");
  }
  const normalized = value.code.toUpperCase().replace(/[ -]/g, "");
  if (!CROCKFORD_CODE.test(normalized)) {
    throw new ApiRequestError(
      422,
      "KIT_CODE_FORMAT_INVALID",
      "Kit codes contain 16 letters or numbers in four groups.",
    );
  }
  return normalized;
}

async function hashKitCode(code: string, pepper: string): Promise<string> {
  if (pepper.length < 16) {
    throw new ApiRequestError(
      503,
      "KIT_SERVICE_UNAVAILABLE",
      "Kit activation is temporarily unavailable.",
    );
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function parseCompileInput(value: unknown): CompileSketchInput {
  if (!isRecord(value)) {
    throw new ApiRequestError(422, "COMPILE_REQUEST_INVALID", "Sketch details are required.");
  }
  const lesson = typeof value.lessonId === "string"
    ? findCurriculumLesson(value.lessonId)
    : undefined;
  if (!lesson) {
    throw new ApiRequestError(404, "LESSON_NOT_FOUND", "That lesson does not exist.");
  }
  if (!Number.isInteger(value.lessonVersion) || Number(value.lessonVersion) < 1) {
    throw new ApiRequestError(422, "LESSON_VERSION_INVALID", "Lesson version is invalid.");
  }
  if (Number(value.lessonVersion) !== lesson.version) {
    throw new ApiRequestError(
      409,
      "LESSON_VERSION_CHANGED",
      "Refresh this lesson before compiling.",
    );
  }
  if (value.fqbn !== FIRELIGHT_BOARD_FQBN) {
    throw new ApiRequestError(
      422,
      "BOARD_TARGET_UNSUPPORTED",
      "Firelight v1 compiles only for the Nano old-bootloader kit board.",
    );
  }
  if (typeof value.source !== "string" || value.source.trim().length === 0) {
    throw new ApiRequestError(422, "SKETCH_REQUIRED", "Enter an Arduino sketch to compile.");
  }
  if (new TextEncoder().encode(value.source).byteLength > MAX_SKETCH_SOURCE_BYTES) {
    throw new ApiRequestError(
      413,
      "SKETCH_TOO_LARGE",
      "Arduino sketches are limited to 64 KiB.",
    );
  }
  if (hasUnsupportedControlCharacter(value.source)) {
    throw new ApiRequestError(
      422,
      "SKETCH_INVALID",
      "The sketch contains unsupported control characters.",
    );
  }
  return {
    lessonId: lesson.id,
    lessonVersion: lesson.version,
    fqbn: FIRELIGHT_BOARD_FQBN,
    source: value.source,
  };
}

function parseUploadEvidenceInput(value: unknown): UploadEvidenceInput {
  if (!isRecord(value)) {
    throw new ApiRequestError(
      422,
      "UPLOAD_EVIDENCE_INVALID",
      "Upload details are required.",
    );
  }
  if (typeof value.compileJobId !== "string" || !UUID_PATTERN.test(value.compileJobId)) {
    throw new ApiRequestError(
      422,
      "COMPILE_JOB_INVALID",
      "The compile job reference is invalid.",
    );
  }
  if (typeof value.artifactHash !== "string" || !SHA256_PATTERN.test(value.artifactHash)) {
    throw new ApiRequestError(
      422,
      "ARTIFACT_HASH_INVALID",
      "The compiled artifact reference is invalid.",
    );
  }
  if (
    !Number.isInteger(value.bytesWritten) ||
    Number(value.bytesWritten) < 1 ||
    Number(value.bytesWritten) > MAX_NANO_UPLOAD_BYTES
  ) {
    throw new ApiRequestError(
      422,
      "UPLOAD_SIZE_INVALID",
      "The reported upload size is invalid.",
    );
  }
  return {
    compileJobId: value.compileJobId,
    artifactHash: value.artifactHash,
    bytesWritten: Number(value.bytesWritten),
  };
}

function requireVerifiedLearner(user: AuthenticatedUser): void {
  if (user.isAnonymous) {
    throw new ApiRequestError(
      403,
      "NON_ANONYMOUS_ACCOUNT_REQUIRED",
      "Sign in with a confirmed Firelight account to use hardware actions.",
    );
  }
  if (!user.emailConfirmed) {
    throw new ApiRequestError(
      403,
      "EMAIL_CONFIRMATION_REQUIRED",
      "Confirm your email before using hardware actions.",
    );
  }
}

function parseProgressInput(value: unknown): ProgressUpdateInput {
  if (!isRecord(value)) {
    throw new ApiRequestError(422, "PROGRESS_INVALID", "Progress data is required.");
  }

  const lessonVersion = value.lessonVersion;
  const expectedRevision = value.expectedRevision;
  const status = value.status;
  const currentStepValue = value.currentStep;
  const percentage = value.percentage;
  const codeSnapshot = value.codeSnapshot;
  const uploadEvidenceId = value.uploadEvidenceId;

  if (!Number.isInteger(lessonVersion) || Number(lessonVersion) < 1) {
    throw new ApiRequestError(422, "LESSON_VERSION_INVALID", "Lesson version is invalid.");
  }
  if (
    expectedRevision !== null &&
    (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1)
  ) {
    throw new ApiRequestError(
      422,
      "PROGRESS_REVISION_INVALID",
      "The saved-progress revision is invalid.",
    );
  }
  if (status === "completed") {
    if (typeof uploadEvidenceId !== "string" || !UUID_PATTERN.test(uploadEvidenceId)) {
      throw new ApiRequestError(
        422,
        "UPLOAD_EVIDENCE_REQUIRED",
        "Upload this compiled sketch before completing the lesson.",
      );
    }
    if (typeof codeSnapshot !== "string" || codeSnapshot.length === 0) {
      throw new ApiRequestError(
        422,
        "COMPLETION_SKETCH_REQUIRED",
        "The completed lesson must include the uploaded sketch.",
      );
    }
  } else if (uploadEvidenceId !== undefined) {
    throw new ApiRequestError(
      422,
      "UPLOAD_EVIDENCE_INVALID",
      "Upload evidence can only be attached to completed progress.",
    );
  }
  if (status !== "not_started" && status !== "in_progress" && status !== "completed") {
    throw new ApiRequestError(422, "PROGRESS_STATUS_INVALID", "Progress status is invalid.");
  }
  if (typeof currentStepValue !== "string") {
    throw new ApiRequestError(422, "CURRENT_STEP_INVALID", "Current step is invalid.");
  }
  const currentStep = currentStepValue.trim();
  if (currentStep.length < 1 || currentStep.length > 100) {
    throw new ApiRequestError(422, "CURRENT_STEP_INVALID", "Current step is invalid.");
  }
  if (!Number.isInteger(percentage) || Number(percentage) < 0 || Number(percentage) > 100) {
    throw new ApiRequestError(422, "PROGRESS_PERCENTAGE_INVALID", "Progress percentage is invalid.");
  }
  const numericPercentage = Number(percentage);
  if (
    (status === "not_started" && numericPercentage !== 0) ||
    (status === "in_progress" && numericPercentage >= 100) ||
    (status === "completed" && numericPercentage !== 100)
  ) {
    throw new ApiRequestError(
      422,
      "PROGRESS_STATE_INVALID",
      "Progress status and percentage do not agree.",
    );
  }
  if (codeSnapshot !== undefined && codeSnapshot !== null && typeof codeSnapshot !== "string") {
    throw new ApiRequestError(422, "CODE_SNAPSHOT_INVALID", "Code snapshot is invalid.");
  }
  if (typeof codeSnapshot === "string" && new TextEncoder().encode(codeSnapshot).byteLength > 65_536) {
    throw new ApiRequestError(413, "CODE_SNAPSHOT_TOO_LARGE", "Code snapshot is too large.");
  }
  if (
    typeof codeSnapshot === "string" &&
    hasUnsupportedControlCharacter(codeSnapshot)
  ) {
    throw new ApiRequestError(
      422,
      "CODE_SNAPSHOT_INVALID",
      "Code snapshot contains unsupported control characters.",
    );
  }

  return {
    lessonVersion: Number(lessonVersion),
    expectedRevision:
      expectedRevision === null ? null : Number(expectedRevision),
    status,
    currentStep,
    percentage: numericPercentage,
    ...(codeSnapshot !== undefined ? { codeSnapshot } : {}),
    ...(typeof uploadEvidenceId === "string" ? { uploadEvidenceId } : {}),
  };
}

function expectedCheckpointPercentage(
  lesson: LessonCatalogEntry,
  stepIndex: number,
): number {
  if (lesson.steps.length === 0) return 0;
  return Math.min(99, Math.floor((stepIndex / lesson.steps.length) * 100));
}

function validateProgressCheckpoint(
  lesson: LessonCatalogEntry,
  input: ProgressUpdateInput,
): void {
  const stepIndex = lesson.steps.findIndex((step) => step.id === input.currentStep);
  const step = lesson.steps[stepIndex];
  if (stepIndex < 0 || !step) {
    throw new ApiRequestError(
      422,
      "CURRENT_STEP_INVALID",
      "That checkpoint is not part of this lesson version.",
    );
  }

  if (input.status === "completed") {
    if (step.type !== "completion") {
      throw new ApiRequestError(
        422,
        "PROGRESS_STATE_INVALID",
        "Completed progress must use the lesson completion checkpoint.",
      );
    }
    return;
  }

  const maximumPercentage = expectedCheckpointPercentage(lesson, stepIndex);
  const minimumPercentage =
    stepIndex === 0 ? 0 : expectedCheckpointPercentage(lesson, stepIndex - 1);
  if (
    input.percentage < minimumPercentage ||
    input.percentage > maximumPercentage
  ) {
    throw new ApiRequestError(
      422,
      "PROGRESS_PERCENTAGE_INVALID",
      "The progress percentage does not match this lesson checkpoint range.",
    );
  }
  if (input.status === "not_started" && stepIndex !== 0) {
    throw new ApiRequestError(
      422,
      "PROGRESS_STATE_INVALID",
      "Not-started progress must use the first lesson checkpoint.",
    );
  }
}

function hasCompletedCurrentLesson(
  progress: readonly LessonProgress[],
  lessonId: string,
): boolean {
  const prerequisite = findLesson(lessonId);
  return (
    prerequisite !== undefined &&
    progress.some(
      (item) =>
        item.lessonId === prerequisite.id &&
        item.lessonVersion === prerequisite.version &&
        item.status === "completed",
    )
  );
}

function isRecentSignIn(lastSignInAt: string | null): boolean {
  if (!lastSignInAt) return false;
  const timestamp = Date.parse(lastSignInAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 15 * 60 * 1000;
}

export function createFirelightApp(dependencies: AppDependencies = {}) {
  const createRepository = dependencies.createRepository ?? createSupabaseIdentityRepository;
  const compilerFetcher = dependencies.compilerFetcher ?? ((request: Request) => fetch(request));
  const app = new Hono<FirelightWorker>();

  const requestContext: MiddlewareHandler<FirelightWorker> = async (context, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    context.set("requestId", requestId);
    context.header("X-Request-ID", requestId);

    await next();

    applyResponseHeaders(context);

    console.log(
      JSON.stringify({
        event: "request.complete",
        requestId,
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: Date.now() - startedAt,
      }),
    );
  };

  const sameOriginMutations: MiddlewareHandler<FirelightWorker> = async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
      await next();
      return;
    }

    const origin = context.req.header("Origin");
    const fetchSite = context.req.header("Sec-Fetch-Site");
    if (
      (origin && origin !== new URL(context.req.url).origin) ||
      fetchSite === "cross-site"
    ) {
      context.res = apiError(
        context,
        403,
        "ORIGIN_REJECTED",
        "Cross-site account requests are not accepted.",
      );
      return;
    }
    await next();
  };

  const requireAuth: MiddlewareHandler<FirelightWorker> = async (context, next) => {
    const authorization = context.req.header("Authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match?.[1]) {
      context.res = apiError(context, 401, "AUTH_REQUIRED", "Sign in to continue.");
      return;
    }

    const repository = createRepository(context.env, match[1]);
    try {
      const user = await repository.authenticate();
      context.set("repository", repository);
      context.set("user", user);
    } catch (error) {
      if (error instanceof RepositoryError) {
        const mapped = mapRepositoryError(error);
        context.res = apiError(context, mapped.status, mapped.code, mapped.message);
        return;
      }
      throw error;
    }
    await next();
  };

  app.use("*", requestContext);
  app.use("/api/*", sameOriginMutations);

  app.get("/api/config", (context) => {
    if (
      !hasRuntimeString(context.env.SUPABASE_URL) ||
      !hasRuntimeString(context.env.SUPABASE_PUBLISHABLE_KEY)
    ) {
      return apiError(
        context,
        503,
        "IDENTITY_SERVICE_UNAVAILABLE",
        "Account services are temporarily unavailable.",
      );
    }
    return context.json({
      data: {
        apiVersion: "v1",
        environment: context.env.ENVIRONMENT,
        buildId: context.env.BUILD_ID,
        supabase: {
          url: context.env.SUPABASE_URL,
          publishableKey: context.env.SUPABASE_PUBLISHABLE_KEY,
        },
        hardware: {
          fqbn: "arduino:avr:nano:cpu=atmega328old",
          uploadBaud: 57_600,
        },
      },
    });
  });

  app.get("/api/bootstrap", requireAuth, async (context) => {
    const user = context.get("user");
    const records = await context.get("repository").getBootstrap(user.id);
    return context.json({ data: buildBootstrap(user, records) });
  });

  app.patch("/api/profile", requireAuth, async (context) => {
    const displayName = parseDisplayName(await readJsonBody(context, 2048));
    const user = context.get("user");
    const profile = await context.get("repository").updateProfile(user.id, displayName);
    return context.json({ data: toLearnerProfile(user, profile) });
  });

  app.post("/api/kits/claim", requireAuth, async (context) => {
    const code = normalizeKitCode(await readJsonBody(context, 2048));
    const codeHash = await hashKitCode(code, context.env.KIT_CODE_PEPPER);
    const user = context.get("user");
    const activation = await context.get("repository").claimKit(user.id, codeHash);
    return context.json({ data: activation });
  });

  app.put("/api/lessons/:id/progress", requireAuth, async (context) => {
    const lesson = findCurriculumLesson(context.req.param("id"));
    const definition = findLesson(lesson?.id);
    if (!lesson || !definition) {
      return apiError(context, 404, "LESSON_NOT_FOUND", "That lesson does not exist.");
    }
    const input = parseProgressInput(await readJsonBody(context, 132 * 1024));
    if (input.lessonVersion !== lesson.version) {
      return apiError(
        context,
        409,
        "LESSON_VERSION_CHANGED",
        "Refresh this lesson before saving progress.",
      );
    }
    validateProgressCheckpoint(definition, input);

    const repository = context.get("repository");
    const user = context.get("user");
    if (!(await repository.hasActivation(user.id))) {
      return apiError(
        context,
        403,
        "ACTIVATION_REQUIRED",
        "Activate a Firelight kit before saving progress.",
      );
    }
    if (definition.prerequisites.length > 0) {
      const records = await repository.getBootstrap(user.id);
      const missing = definition.prerequisites.filter(
        (prerequisite) => !hasCompletedCurrentLesson(records.progress, prerequisite),
      );
      if (missing.length > 0) {
        return apiError(
          context,
          403,
          "LESSON_PREREQUISITE_REQUIRED",
          "Complete this lesson's prerequisites before saving progress.",
        );
      }
    }
    try {
      const progress = await repository.upsertProgress(user.id, lesson.id, input);
      return context.json({ data: progress });
    } catch (error) {
      if (error instanceof RepositoryError && error.kind === "forbidden") {
        return apiError(
          context,
          403,
          "ACTIVATION_REQUIRED",
          "Kit access is no longer active. Activate a Firelight kit to save progress.",
        );
      }
      if (error instanceof RepositoryError && error.kind === "conflict") {
        return apiError(
          context,
          409,
          "PROGRESS_REVISION_CONFLICT",
          "This lesson changed on another device. Refresh and try again.",
        );
      }
      if (
        input.status === "completed" &&
        error instanceof RepositoryError &&
        error.kind === "invalid"
      ) {
        return apiError(
          context,
          422,
          "COMPLETION_EVIDENCE_REJECTED",
          "Compile and upload this exact sketch before completing the lesson.",
        );
      }
      throw error;
    }
  });

  app.post("/api/compile", requireAuth, async (context) => {
    const input = parseCompileInput(await readJsonBody(context, 512 * 1024));
    const repository = context.get("repository");
    const user = context.get("user");
    requireVerifiedLearner(user);
    if (!(await repository.hasActivation(user.id))) {
      return apiError(
        context,
        403,
        "ACTIVATION_REQUIRED",
        "Activate a Firelight kit before compiling.",
      );
    }
    const definition = findLesson(input.lessonId);
    if (definition?.version !== input.lessonVersion) {
      return apiError(
        context,
        409,
        "LESSON_VERSION_CHANGED",
        "Refresh this lesson before compiling.",
      );
    }
    if (definition.prerequisites.length > 0) {
      const records = await repository.getBootstrap(user.id);
      const missing = definition.prerequisites.filter(
        (prerequisite) => !hasCompletedCurrentLesson(records.progress, prerequisite),
      );
      if (missing.length > 0) {
        return apiError(
          context,
          403,
          "LESSON_PREREQUISITE_REQUIRED",
          "Complete this lesson's prerequisites before compiling.",
        );
      }
    }
    const compileStep = definition.steps.find((step) => step.type === "compile");
    const validationStep = compileStep
      ? definition.steps.find(
          (step) => step.type === "code-validation" && step.id === compileStep.validationStepId,
        )
      : undefined;
    if (validationStep?.type !== "code-validation") {
      return apiError(
        context,
        503,
        "LESSON_CONFIGURATION_INVALID",
        "This lesson is temporarily unavailable for compilation.",
      );
    }
    const lessonValidation = validateLessonCode(validationStep.validatorId, input.source);
    if (!lessonValidation.valid) {
      return apiError(
        context,
        422,
        "LESSON_CODE_CHECK_FAILED",
        "Run the lesson code check and fix the highlighted requirements first.",
      );
    }

    const sourceHash = await sha256Hex(input.source);
    const gate = await repository.beginCompileJob(user.id, {
      lessonId: input.lessonId,
      lessonVersion: input.lessonVersion,
      sourceHash,
    });
    if (gate.result === "active") {
      return apiError(
        context,
        409,
        "COMPILE_ALREADY_RUNNING",
        "Wait for the current compile to finish before starting another.",
      );
    }
    if (gate.result === "rate_limited") {
      context.header("Retry-After", String(gate.retryAfterSeconds));
      return apiError(
        context,
        429,
        gate.scope === "hour" ? "COMPILE_HOURLY_LIMIT" : "COMPILE_DAILY_LIMIT",
        gate.scope === "hour"
          ? "The hourly compile limit has been reached. Try again later."
          : "The daily compile limit has been reached. Try again tomorrow.",
      );
    }
    if (gate.result === "not_entitled") {
      return apiError(
        context,
        403,
        "ACTIVATION_REQUIRED",
        "Activate a Firelight kit before compiling.",
      );
    }

    const startedAt = Date.now();
    try {
      const result = await requestCompilation(
        {
          url: context.env.COMPILER_SERVICE_URL,
          expectedOrigin: context.env.COMPILER_SERVICE_ORIGIN,
          token: context.env.COMPILER_SERVICE_TOKEN,
          environment: context.env.ENVIRONMENT,
        },
        input.source,
        sourceHash,
        compilerFetcher,
      );
      const durationMs = Math.min(60_000, Math.max(0, Date.now() - startedAt));
      await repository.finishCompileJob(user.id, {
        jobId: gate.jobId,
        state: "succeeded",
        durationMs,
        safeErrorCode: null,
        artifactHash: result.artifactHash,
        diagnosticSummary: diagnosticSummary(result.diagnostics),
      });
      return context.json({
        data: {
          compileJobId: gate.jobId,
          format: "intel-hex" as const,
          fqbn: FIRELIGHT_BOARD_FQBN,
          sourceHash: result.sourceHash,
          artifactHash: result.artifactHash,
          hex: result.hex,
          diagnostics: result.diagnostics,
        },
      });
    } catch (error) {
      if (error instanceof RepositoryError && error.kind === "forbidden") {
        return apiError(
          context,
          403,
          "ACTIVATION_REQUIRED",
          "Kit access was revoked before compilation completed.",
        );
      }
      const failure = error instanceof CompilerGatewayError
        ? error
        : new CompilerGatewayError(
            "upstream",
            "COMPILER_INTERNAL_ERROR",
            "The compiler could not complete this request.",
          );
      const durationMs = Math.min(60_000, Math.max(0, Date.now() - startedAt));
      try {
        await repository.finishCompileJob(user.id, {
          jobId: gate.jobId,
          state: "failed",
          durationMs,
          safeErrorCode: failure.code,
          artifactHash: null,
          diagnosticSummary: diagnosticSummary(
            failure.diagnostics.length > 0 ? failure.diagnostics : [failure.message],
          ),
        });
      } catch (finishError) {
        if (finishError instanceof RepositoryError && finishError.kind === "forbidden") {
          return apiError(
            context,
            403,
            "ACTIVATION_REQUIRED",
            "Kit access was revoked before compilation completed.",
          );
        }
        console.error(
          JSON.stringify({
            event: "compile.finish_failed",
            requestId: context.get("requestId"),
            jobId: gate.jobId,
            errorType: finishError instanceof Error ? finishError.name : "unknown",
          }),
        );
        return apiError(
          context,
          503,
          "COMPILE_STATE_UNAVAILABLE",
          "The compile result could not be recorded. Try again.",
        );
      }

      const status: ErrorStatus = failure.kind === "compile"
        ? 422
        : failure.kind === "timeout"
          ? 504
          : failure.kind === "configuration"
            ? 503
            : 502;
      return apiError(context, status, failure.code, failure.message);
    }
  });

  app.post("/api/hardware/upload-evidence", requireAuth, async (context) => {
    const input = parseUploadEvidenceInput(await readJsonBody(context, 4096));
    const repository = context.get("repository");
    const user = context.get("user");
    requireVerifiedLearner(user);
    if (!(await repository.hasActivation(user.id))) {
      return apiError(
        context,
        403,
        "ACTIVATION_REQUIRED",
        "Activate a Firelight kit before recording an upload.",
      );
    }
    try {
      const evidence = await repository.recordUploadEvidence(
        user.id,
        input.compileJobId,
        input.artifactHash,
        input.bytesWritten,
      );
      return context.json({ data: evidence });
    } catch (error) {
      if (error instanceof RepositoryError && error.kind === "forbidden") {
        return apiError(
          context,
          403,
          "ACTIVATION_REQUIRED",
          "Kit access is no longer active. Activate a Firelight kit before recording an upload.",
        );
      }
      if (error instanceof RepositoryError && error.kind === "invalid") {
        return apiError(
          context,
          422,
          "UPLOAD_EVIDENCE_REJECTED",
          "The upload did not match this account's compiled sketch.",
        );
      }
      throw error;
    }
  });

  app.delete("/api/account", requireAuth, async (context) => {
    const user = context.get("user");
    if (!isRecentSignIn(user.lastSignInAt)) {
      return apiError(
        context,
        403,
        "RECENT_SIGN_IN_REQUIRED",
        "Sign out and sign in again before deleting this account.",
      );
    }
    await context.get("repository").deleteAccount(user.id);
    return context.json({ data: { deleted: true } });
  });

  const methodRules = [
    ["/api/config", "GET, HEAD"],
    ["/api/bootstrap", "GET, HEAD"],
    ["/api/profile", "PATCH"],
    ["/api/kits/claim", "POST"],
    ["/api/lessons/:id/progress", "PUT"],
    ["/api/compile", "POST"],
    ["/api/hardware/upload-evidence", "POST"],
    ["/api/account", "DELETE"],
  ] as const;

  for (const [path, allowed] of methodRules) {
    app.all(path, (context) => {
      context.header("Allow", allowed);
      return apiError(
        context,
        405,
        "METHOD_NOT_ALLOWED",
        `This endpoint only accepts ${allowed} requests.`,
      );
    });
  }

  const legacyRedirects = {
    "/index.html": "/",
    "/dashboard.html": "/camp",
    "/learn.html": "/learn",
    "/product.html": "/kit",
    "/tutorial.html": "/learn/first-spark",
    "/second-tutorial": "/learn/morse-name",
    "/second-tutorial/": "/learn/morse-name",
    "/second-tutorial/index.html": "/learn/morse-name",
  } as const;

  for (const [legacyPath, destination] of Object.entries(legacyRedirects)) {
    app.get(legacyPath, (context) => {
      const redirectUrl = new URL(destination, context.req.url);
      return context.redirect(redirectUrl.toString(), 308);
    });
  }

  app.notFound((context) => {
    if (!isApiPath(context.req.path)) {
      return context.env.ASSETS.fetch(context.req.raw);
    }

    return apiError(context, 404, "NOT_FOUND", "The requested API route does not exist.");
  });

  app.onError((error, context) => {
    let mappedError: ApiRequestError;
    if (error instanceof ApiRequestError) {
      mappedError = error;
    } else if (error instanceof RepositoryError) {
      mappedError = mapRepositoryError(error);
      console.error(
        JSON.stringify({
          event: "repository.error",
          requestId: context.get("requestId"),
          path: context.req.path,
          kind: error.kind,
          upstreamCode: error.upstreamCode,
        }),
      );
    } else {
      mappedError = new ApiRequestError(
        500,
        "INTERNAL_ERROR",
        "Firelight could not complete the request.",
      );
      console.error(
        JSON.stringify({
          event: "request.error",
          requestId: context.get("requestId"),
          method: context.req.method,
          path: context.req.path,
          errorType: error.name,
        }),
      );
    }

    applyResponseHeaders(context);
    return apiError(context, mappedError.status, mappedError.code, mappedError.message);
  });

  return app;
}

const app = createFirelightApp();

export { app };
export default app;
