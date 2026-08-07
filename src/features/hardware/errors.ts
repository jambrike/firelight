export type HardwareTransportErrorCode =
  | "not-secure-context"
  | "web-serial-unavailable"
  | "mobile-device"
  | "operation-in-progress"
  | "connection-cancelled"
  | "connection-failed"
  | "device-not-connected"
  | "device-disconnected"
  | "port-close-failed"
  | "artifact-invalid"
  | "upload-cancelled"
  | "upload-failed";

/** A user-safe hardware failure. Source code and HEX contents are never included. */
export class HardwareTransportError extends Error {
  readonly code: HardwareTransportErrorCode;

  constructor(code: HardwareTransportErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HardwareTransportError";
    this.code = code;
  }
}

export function createAbortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof HardwareTransportError &&
      (error.code === "connection-cancelled" || error.code === "upload-cancelled")) ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
