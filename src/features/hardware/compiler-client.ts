import { isLessonSlug } from "../../../shared/curriculum";
import type { UploadEvidence } from "../../../shared/hardware";
import { FirelightApi } from "../identity/api";
import type {
  CompileArtifact,
  CompileRequest,
  CompilerClient,
  UploadResult,
} from "./contracts";

export interface UploadEvidenceRecorder {
  record(
    artifact: CompileArtifact,
    result: UploadResult,
    signal?: AbortSignal,
  ): Promise<UploadEvidence>;
}

/** Authenticated browser client. Compiler location and service token stay in the Worker. */
export class FirelightHardwareApi implements CompilerClient, UploadEvidenceRecorder {
  readonly #api: FirelightApi;

  constructor(getAccessToken: () => string | null) {
    this.#api = new FirelightApi(getAccessToken);
  }

  compile(request: CompileRequest, signal?: AbortSignal): Promise<CompileArtifact> {
    if (!isLessonSlug(request.lessonId)) {
      return Promise.reject(new TypeError("The lesson identifier is not supported."));
    }
    return this.#api.compileSketch(
      {
        lessonId: request.lessonId,
        lessonVersion: request.lessonVersion,
        fqbn: request.fqbn,
        source: request.source,
      },
      signal,
    );
  }

  record(
    artifact: CompileArtifact,
    result: UploadResult,
    signal?: AbortSignal,
  ): Promise<UploadEvidence> {
    return this.#api.recordUploadEvidence({
      compileJobId: artifact.compileJobId,
      artifactHash: artifact.artifactHash,
      bytesWritten: result.bytesWritten,
    }, signal);
  }
}
