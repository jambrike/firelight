import type { LessonSlug } from "../../../shared/curriculum";
import type {
  ApiErrorBody,
  BootstrapData,
  KitActivation,
  LearnerProfile,
  LessonProgress,
  ProgressUpdateInput,
  PublicRuntimeConfig,
} from "../../../shared/identity";

export class FirelightApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "FirelightApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseErrorBody(value: unknown): ApiErrorBody["error"] | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const error = value.error;
  if (
    typeof error.code !== "string" ||
    typeof error.message !== "string" ||
    typeof error.requestId !== "string"
  ) {
    return null;
  }
  return {
    code: error.code,
    message: error.message,
    requestId: error.requestId,
  };
}

export class FirelightApi {
  readonly #getAccessToken: () => string | null;

  constructor(getAccessToken: () => string | null = () => null) {
    this.#getAccessToken = getAccessToken;
  }

  async #request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (authenticated) {
      const token = this.#getAccessToken();
      if (!token) {
        throw new FirelightApiError(401, "AUTH_REQUIRED", "Sign in to continue.");
      }
      headers.set("Authorization", `Bearer ${token}`);
    }

    let response: Response;
    try {
      response = await fetch(path, { ...init, headers });
    } catch {
      throw new FirelightApiError(
        0,
        "NETWORK_ERROR",
        "Firelight could not reach account services.",
      );
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new FirelightApiError(
        response.status,
        "INVALID_RESPONSE",
        "Firelight received an invalid account-service response.",
      );
    }

    if (!response.ok) {
      const error = parseErrorBody(body);
      throw new FirelightApiError(
        response.status,
        error?.code ?? "REQUEST_FAILED",
        error?.message ?? "Firelight could not complete the request.",
        error?.requestId ?? response.headers.get("X-Request-ID"),
      );
    }
    if (!isRecord(body) || !("data" in body)) {
      throw new FirelightApiError(
        response.status,
        "INVALID_RESPONSE",
        "Firelight received an invalid account-service response.",
      );
    }
    return body.data as T;
  }

  getConfig(): Promise<PublicRuntimeConfig> {
    return this.#request<PublicRuntimeConfig>("/api/config", {}, false);
  }

  getBootstrap(): Promise<BootstrapData> {
    return this.#request<BootstrapData>("/api/bootstrap");
  }

  updateProfile(displayName: string): Promise<LearnerProfile> {
    return this.#request<LearnerProfile>("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    });
  }

  claimKit(code: string): Promise<KitActivation> {
    return this.#request<KitActivation>("/api/kits/claim", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  saveProgress(lessonId: LessonSlug, input: ProgressUpdateInput): Promise<LessonProgress> {
    return this.#request<LessonProgress>(
      `/api/lessons/${encodeURIComponent(lessonId)}/progress`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    );
  }

  deleteAccount(): Promise<{ readonly deleted: true }> {
    return this.#request<{ readonly deleted: true }>("/api/account", {
      method: "DELETE",
    });
  }
}
