import { isRfc3339Timestamp, type UploadEvidence } from "../../../shared/hardware";
import type { UploadEvidenceRecorder } from "./compiler-client";
import type {
  ArduinoDeviceMetadata,
  ArduinoTransport,
  CompileArtifact,
  CompileRequest,
  CompilerClient,
  HardwareCapability,
  HardwareWorkflowPhase,
  SerialReadResult,
  UploadProgress,
} from "./contracts";
import { sha256TextHex } from "./artifact";
import { isAbortError } from "./errors";

export interface HardwareWorkflowSnapshot {
  readonly phase: HardwareWorkflowPhase;
  readonly capability: HardwareCapability;
  readonly artifact: CompileArtifact | null;
  readonly device: ArduinoDeviceMetadata | null;
  readonly progress: UploadProgress | null;
  readonly evidence: UploadEvidence | null;
  readonly serial: SerialReadResult | null;
  readonly serialReading: boolean;
  readonly error: string | null;
}

export interface HardwareWorkflowDependencies {
  readonly compiler: CompilerClient;
  readonly transport: ArduinoTransport;
  readonly evidenceRecorder: UploadEvidenceRecorder;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<HardwareWorkflowPhase, ReadonlySet<HardwareWorkflowPhase>>
> = {
  idle: new Set(["compiling", "compiled", "connecting", "error"]),
  compiling: new Set(["compiled", "idle", "error"]),
  compiled: new Set(["compiling", "connecting", "idle", "error"]),
  connecting: new Set(["connected", "compiled", "idle", "error"]),
  connected: new Set(["compiling", "compiled", "uploading", "idle", "error"]),
  uploading: new Set(["success", "compiled", "connected", "idle", "error"]),
  success: new Set(["compiling", "compiled", "connected", "uploading", "idle", "error"]),
  error: new Set([
    "compiling",
    "compiled",
    "connecting",
    "connected",
    "uploading",
    "success",
    "idle",
  ]),
};

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The hardware workflow could not complete this action.";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isBrowserUploadAttestation(
  value: unknown,
): value is "browser-web-serial-v1" {
  return value === "browser-web-serial-v1";
}

/**
 * One explicit compile → connect → upload state machine. A compile artifact is
 * invalidated immediately whenever the editor changes, and success is terminal
 * only after the server records browser-reported upload evidence.
 */
export class HardwareWorkflowController {
  readonly #compiler: CompilerClient;
  readonly #transport: ArduinoTransport;
  readonly #evidenceRecorder: UploadEvidenceRecorder;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeTransport: () => void;
  #snapshot: HardwareWorkflowSnapshot;
  #operation: AbortController | null = null;
  #compiledLesson: { readonly id: string; readonly version: number } | null = null;
  #disposed = false;

  constructor(dependencies: HardwareWorkflowDependencies) {
    this.#compiler = dependencies.compiler;
    this.#transport = dependencies.transport;
    this.#evidenceRecorder = dependencies.evidenceRecorder;
    this.#snapshot = {
      phase: "idle",
      capability: this.#transport.detectCapability(),
      artifact: null,
      device: null,
      progress: null,
      evidence: null,
      serial: null,
      serialReading: false,
      error: null,
    };
    this.#unsubscribeTransport = this.#transport.subscribe((phase) => {
      if (phase === "error" && this.#snapshot.phase !== "error") {
        const preserveEvidence = this.#snapshot.evidence;
        this.#operation?.abort(new DOMException("The serial device disconnected.", "AbortError"));
        this.#operation = null;
        this.#transition("error", {
          device: null,
          evidence: preserveEvidence,
          serialReading: false,
          progress: null,
          error: "The board disconnected. Reconnect it before uploading again.",
        });
      }
    });
  }

  readonly getSnapshot = (): HardwareWorkflowSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  async compile(request: CompileRequest): Promise<CompileArtifact> {
    this.#assertReady();
    const operation = this.#beginOperation();
    try {
      this.#compiledLesson = null;
      this.#transition("compiling", {
        artifact: null,
        evidence: null,
        serial: null,
        serialReading: false,
        progress: null,
        error: null,
      });
      const artifact = await this.#compiler.compile(request, operation.signal);
      this.#requireCurrentOperation(operation);
      const expectedSourceHash = await sha256TextHex(request.source);
      this.#requireCurrentOperation(operation);
      if (artifact.sourceHash !== expectedSourceHash) {
        throw new Error("The compiled artifact did not match the current sketch.");
      }
      await this.#transport.validateArtifact(artifact);
      this.#requireCurrentOperation(operation);
      this.#compiledLesson = { id: request.lessonId, version: request.lessonVersion };
      this.#transition(this.#snapshot.device ? "connected" : "compiled", {
        artifact,
        evidence: null,
        error: null,
      });
      return artifact;
    } catch (error) {
      this.#handleOperationError(error, operation);
      throw error;
    } finally {
      this.#finishOperation(operation);
    }
  }

  async connect(): Promise<ArduinoDeviceMetadata> {
    this.#assertReady();
    if (!this.#snapshot.artifact) {
      throw new Error("Compile the current sketch before connecting the board.");
    }
    if (this.#snapshot.device) return this.#snapshot.device;
    const operation = this.#beginOperation();
    try {
      this.#transition("connecting", { error: null, progress: null });
      const device = await this.#transport.connect(operation.signal);
      this.#requireCurrentOperation(operation);
      this.#transition("connected", { device, error: null });
      return device;
    } catch (error) {
      this.#handleOperationError(error, operation);
      throw error;
    } finally {
      this.#finishOperation(operation);
    }
  }

  async upload(): Promise<UploadEvidence> {
    this.#assertReady();
    const artifact = this.#snapshot.artifact;
    if (!artifact) throw new Error("Compile the current sketch before uploading.");
    if (!this.#snapshot.device) throw new Error("Connect the Nano before uploading.");
    const operation = this.#beginOperation();
    try {
      this.#transition("uploading", {
        serial: null,
        serialReading: false,
        progress: null,
        error: null,
      });
      const result = await this.#transport.upload(
        artifact,
        (progress) => {
          if (this.#operation === operation && this.#snapshot.phase === "uploading") {
            this.#publish({ progress });
          }
        },
        operation.signal,
      );
      this.#requireCurrentOperation(operation);
      const evidence = await this.#evidenceRecorder.record(
        artifact,
        result,
        operation.signal,
      );
      this.#requireCurrentOperation(operation);
      const compiledLesson = this.#compiledLesson;
      if (!compiledLesson) {
        throw new Error("The compiled artifact is missing its lesson binding.");
      }
      if (
        typeof evidence.id !== "string" ||
        !UUID_PATTERN.test(evidence.id) ||
        evidence.compileJobId !== artifact.compileJobId ||
        evidence.artifactHash !== artifact.artifactHash ||
        evidence.sourceHash !== artifact.sourceHash ||
        evidence.lessonId !== compiledLesson.id ||
        evidence.lessonVersion !== compiledLesson.version ||
        evidence.bytesWritten !== result.bytesWritten ||
        !Number.isSafeInteger(evidence.bytesWritten) ||
        evidence.bytesWritten < 1 ||
        !isBrowserUploadAttestation(evidence.attestation) ||
        !isRfc3339Timestamp(evidence.recordedAt)
      ) {
        throw new Error("The recorded upload did not match the compiled artifact.");
      }
      this.#transition("success", { evidence, progress: null, error: null });
      return evidence;
    } catch (error) {
      this.#handleOperationError(error, operation);
      throw error;
    } finally {
      this.#finishOperation(operation);
    }
  }

  async readSerial(baudRate: 9_600): Promise<SerialReadResult> {
    this.#assertReady();
    if (!this.#snapshot.evidence) {
      throw new Error("Upload the current sketch before reading serial output.");
    }
    if (!this.#snapshot.device) {
      throw new Error("Reconnect the Nano before reading serial output.");
    }
    const operation = this.#beginOperation();
    this.#publish({
      serial: { baudRate, text: "", bytesRead: 0, truncated: false },
      serialReading: true,
      error: null,
    });
    try {
      const result = await this.#transport.readSerial(
        { baudRate },
        (text) => {
          if (this.#operation !== operation || operation.signal.aborted) return;
          const current = this.#snapshot.serial;
          const output = `${current?.text ?? ""}${text}`;
          this.#publish({
            serial: {
              baudRate,
              text: output,
              bytesRead: new TextEncoder().encode(output).byteLength,
              truncated: false,
            },
          });
        },
        operation.signal,
      );
      this.#requireCurrentOperation(operation);
      this.#publish({ serial: result, serialReading: false, error: null });
      return result;
    } catch (error) {
      this.#handleOperationError(error, operation);
      throw error;
    } finally {
      this.#finishOperation(operation);
    }
  }

  async invalidateCode(): Promise<void> {
    this.#assertNotDisposed();
    const operation = this.#claimCancellationOperation("The sketch changed.");
    const hadBoardOperation = this.#transport.phase === "connecting" ||
      this.#transport.phase === "uploading" ||
      this.#snapshot.serialReading;
    this.#compiledLesson = null;
    try {
      if (hadBoardOperation) await this.#transport.cancel();
    } finally {
      if (this.#operation === operation) {
        this.#transition(
          !hadBoardOperation && this.#snapshot.device ? "connected" : "idle",
          {
            artifact: null,
            evidence: null,
            serial: null,
            serialReading: false,
            progress: null,
            error: null,
            ...(hadBoardOperation ? { device: null } : {}),
          },
        );
        this.#operation = null;
      }
    }
  }

  async cancel(): Promise<void> {
    this.#assertNotDisposed();
    const operation = this.#claimCancellationOperation(
      "The hardware action was cancelled.",
    );
    try {
      await this.#transport.cancel();
    } finally {
      if (this.#operation === operation) {
        this.#transition(
          this.#snapshot.evidence
            ? "success"
            : this.#snapshot.artifact
              ? "compiled"
              : "idle",
          {
            device: null,
            progress: null,
            serialReading: false,
            error: null,
          },
        );
        this.#operation = null;
      }
    }
  }

  async disconnect(): Promise<void> {
    this.#assertNotDisposed();
    const operation = this.#claimCancellationOperation("The board was disconnected.");
    try {
      await this.#transport.disconnect();
    } finally {
      if (this.#operation === operation) {
        const hasRecordedEvidence = this.#snapshot.evidence !== null;
        this.#transition(
          hasRecordedEvidence
            ? "success"
            : this.#snapshot.artifact
              ? "compiled"
              : "idle",
          {
            device: null,
            progress: null,
            serialReading: false,
            error: null,
          },
        );
        this.#operation = null;
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#operation?.abort(new DOMException("The lesson was closed.", "AbortError"));
    this.#operation = null;
    this.#unsubscribeTransport();
    try {
      await this.#transport.disconnect();
    } finally {
      this.#listeners.clear();
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("The hardware workflow is closed.");
  }

  #assertReady(): void {
    this.#assertNotDisposed();
    if (this.#operation) throw new Error("Another hardware action is already running.");
  }

  #beginOperation(): AbortController {
    const operation = new AbortController();
    this.#operation = operation;
    return operation;
  }

  #claimCancellationOperation(message: string): AbortController {
    const operation = this.#operation ?? new AbortController();
    this.#operation = operation;
    operation.abort(new DOMException(message, "AbortError"));
    return operation;
  }

  #requireCurrentOperation(operation: AbortController): void {
    if (
      this.#disposed ||
      this.#operation !== operation ||
      operation.signal.aborted
    ) {
      throw operation.signal.reason instanceof Error
        ? operation.signal.reason
        : new DOMException("The hardware action was cancelled.", "AbortError");
    }
  }

  #finishOperation(operation: AbortController): void {
    // An explicit cancel/invalidation owns the aborted operation until its
    // transport cleanup finishes, so a replacement action cannot overlap it.
    if (this.#operation === operation && !operation.signal.aborted) {
      this.#operation = null;
    }
  }

  #handleOperationError(error: unknown, operation: AbortController): void {
    if (this.#disposed || this.#operation !== operation) return;
    if (isAbortError(error)) {
      this.#transition(
        this.#snapshot.evidence
          ? "success"
          : this.#snapshot.artifact
            ? "compiled"
            : "idle",
        {
          progress: null,
          serialReading: false,
          error: null,
        },
      );
      return;
    }
    this.#transition("error", {
      progress: null,
      serialReading: false,
      error: messageFrom(error),
    });
  }

  #transition(
    phase: HardwareWorkflowPhase,
    update: Partial<Omit<HardwareWorkflowSnapshot, "phase" | "capability">> = {},
  ): void {
    if (phase !== this.#snapshot.phase && !ALLOWED_TRANSITIONS[this.#snapshot.phase].has(phase)) {
      throw new Error(`Invalid hardware transition: ${this.#snapshot.phase} -> ${phase}`);
    }
    this.#snapshot = { ...this.#snapshot, ...update, phase };
    for (const listener of this.#listeners) listener();
  }

  #publish(update: Partial<Omit<HardwareWorkflowSnapshot, "phase" | "capability">>): void {
    this.#snapshot = { ...this.#snapshot, ...update };
    for (const listener of this.#listeners) listener();
  }
}
