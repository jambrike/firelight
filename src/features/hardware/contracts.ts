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
  readonly format: "intel-hex";
  readonly fqbn: typeof FIRELIGHT_BOARD_FQBN;
  readonly sourceHash: string;
  readonly hex: string;
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
  validateArtifact(artifact: CompileArtifact): Promise<void>;
  upload(
    artifact: CompileArtifact,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<UploadResult>;
  subscribe(listener: (phase: HardwareWorkflowPhase) => void): () => void;
}
