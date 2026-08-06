import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { curriculumLessons, findCurriculumLesson } from "../shared/curriculum";
import type {
  Achievement,
  BootstrapData,
  LearnerProfile,
  ProgressUpdateInput,
} from "../shared/identity";
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
  | 503;

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

function parseProgressInput(value: unknown): ProgressUpdateInput {
  if (!isRecord(value)) {
    throw new ApiRequestError(422, "PROGRESS_INVALID", "Progress data is required.");
  }

  const lessonVersion = value.lessonVersion;
  const status = value.status;
  const currentStepValue = value.currentStep;
  const percentage = value.percentage;
  const codeSnapshot = value.codeSnapshot;

  if (!Number.isInteger(lessonVersion) || Number(lessonVersion) < 1) {
    throw new ApiRequestError(422, "LESSON_VERSION_INVALID", "Lesson version is invalid.");
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
    status,
    currentStep,
    percentage: numericPercentage,
    ...(codeSnapshot !== undefined ? { codeSnapshot } : {}),
  };
}

function isRecentSignIn(lastSignInAt: string | null): boolean {
  if (!lastSignInAt) return false;
  const timestamp = Date.parse(lastSignInAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 15 * 60 * 1000;
}

export function createFirelightApp(dependencies: AppDependencies = {}) {
  const createRepository = dependencies.createRepository ?? createSupabaseIdentityRepository;
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
    if (!lesson) {
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
    const progress = await repository.upsertProgress(user.id, lesson.id, input);
    return context.json({ data: progress });
  });

  app.post("/api/compile", requireAuth, async (context) => {
    const repository = context.get("repository");
    const user = context.get("user");
    if (!(await repository.hasActivation(user.id))) {
      return apiError(
        context,
        403,
        "ACTIVATION_REQUIRED",
        "Activate a Firelight kit before compiling.",
      );
    }
    return apiError(
      context,
      503,
      "COMPILER_NOT_READY",
      "The secure compiler arrives in the hardware pipeline milestone.",
    );
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
