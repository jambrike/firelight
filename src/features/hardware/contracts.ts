export const FIRELIGHT_BOARD_FQBN = "arduino:avr:nano:cpu=atmega328old";
export const FIRELIGHT_UPLOAD_BAUD = 57_600;

export type HardwareWorkflowPhase =
  | "idle"
  | "compiling"
  | "compiled"
  | "connecting"
  | "connected"
  | "uploading"
  | "success"
  | "error";

export interface HardwareCapability {
  readonly supported: boolean;
  readonly reason?:
    | "not-secure-context"
    | "web-serial-unavailable"
    | "mobile-device";
}

export interface ArduinoDeviceMetadata {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
  readonly displayName: string;
}

export interface CompileArtifact {
  readonly compileJobId: string;
  readonly format: "intel-hex";
  readonly fqbn: typeof FIRELIGHT_BOARD_FQBN;
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly hex: string;
  readonly diagnostics: readonly string[];
}

export interface CompileRequest {
  readonly lessonId: string;
  readonly lessonVersion: number;
  readonly fqbn: typeof FIRELIGHT_BOARD_FQBN;
  readonly source: string;
}

/** Milestone 4 implements this port against the authenticated compiler API. */
export interface CompilerClient {
  compile(request: CompileRequest, signal?: AbortSignal): Promise<CompileArtifact>;
}

export interface UploadProgress {
  readonly phase: "preparing" | "resetting" | "writing" | "verifying";
  readonly bytesWritten: number;
  readonly totalBytes: number;
}

export interface UploadResult {
  readonly bytesWritten: number;
  readonly completedAt: string;
}

export interface ArduinoTransport {
  readonly phase: HardwareWorkflowPhase;
  detectCapability(): HardwareCapability;
  connect(signal?: AbortSignal): Promise<ArduinoDeviceMetadata>;
  disconnect(): Promise<void>;
  cancel(): Promise<void>;
  validateArtifact(artifact: CompileArtifact): Promise<void>;
  upload(
    artifact: CompileArtifact,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<UploadResult>;
  subscribe(listener: (phase: HardwareWorkflowPhase) => void): () => void;
}

export interface LessonHardwarePorts {
  readonly compiler: CompilerClient;
  readonly transport: ArduinoTransport;
}
