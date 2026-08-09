import { validateCompileArtifact, type Sha256Digest } from "./artifact";
import {
  FIRELIGHT_SERIAL_BAUD,
  FIRELIGHT_UPLOAD_BAUD,
  type ArduinoDeviceMetadata,
  type ArduinoTransport,
  type CompileArtifact,
  type HardwareCapability,
  type HardwareWorkflowPhase,
  type SerialReadOptions,
  type SerialReadResult,
  type UploadProgress,
  type UploadResult,
} from "./contracts";
import {
  createAbortError,
  HardwareTransportError,
  isAbortError,
} from "./errors";
import {
  uploadStk500v1,
  type Stk500UploadOptions,
  type Stk500UploadResult,
} from "./stk500v1";
import type {
  SerialDisconnectEventLike,
  SerialDisconnectListener,
  WebSerialLike,
  WebSerialPortLike,
} from "./serial-types";

export interface BrowserSerialEnvironment {
  readonly secureContext: boolean;
  readonly userAgent: string;
  readonly serial?: WebSerialLike;
}

export type Stk500Uploader = (
  port: WebSerialPortLike,
  image: Uint8Array,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
  options?: Stk500UploadOptions,
) => Promise<Stk500UploadResult>;

export interface WebSerialArduinoTransportOptions {
  readonly environment?: BrowserSerialEnvironment;
  readonly digestHex?: Sha256Digest;
  readonly uploader?: Stk500Uploader;
  readonly uploaderOptions?: Stk500UploadOptions;
  readonly now?: () => Date;
}

interface OpenConnection {
  readonly port: WebSerialPortLike;
  readonly metadata: ArduinoDeviceMetadata;
  readonly detachDisconnectListeners: () => void;
  baudRate: number;
}

interface CapturedSerialText {
  readonly text: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly readerCancelled: boolean;
}

const DEFAULT_SERIAL_CAPTURE_DURATION_MS = 10_000;
const MAX_SERIAL_CAPTURE_DURATION_MS = 30_000;
const DEFAULT_SERIAL_CAPTURE_BYTES = 8_192;
const MAX_SERIAL_CAPTURE_BYTES = 16_384;

function serialOpenOptions(baudRate: number) {
  return {
    baudRate,
    dataBits: 8 as const,
    stopBits: 1 as const,
    parity: "none" as const,
    bufferSize: 255,
    flowControl: "none" as const,
  };
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${label} must be a positive integer no larger than ${String(maximum)}.`);
  }
  return resolved;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array ||
    Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isSupportedSerialBaud(value: unknown): value is typeof FIRELIGHT_SERIAL_BAUD {
  return value === FIRELIGHT_SERIAL_BAUD;
}

async function captureSerialText(
  port: WebSerialPortLike,
  durationMs: number,
  maxBytes: number,
  onData: (text: string) => void,
  signal: AbortSignal,
): Promise<CapturedSerialText> {
  const readable = port.readable;
  if (!readable) {
    throw new HardwareTransportError(
      "serial-read-failed",
      "The board's serial output stream is unavailable.",
    );
  }
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let truncated = false;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let readerCancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let captured: Omit<CapturedSerialText, "readerCancelled"> | undefined;

  const stopped = new Promise<{ readonly kind: "timeout" }>((resolve, reject) => {
    timeout = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, durationMs);
    abortListener = () => {
      reject(abortReason(signal, "Serial reading was cancelled."));
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    if (signal.aborted) throw abortReason(signal, "Serial reading was cancelled.");
    while (bytesRead < maxBytes) {
      pendingRead = reader.read();
      const outcome = await Promise.race([
        pendingRead.then((result) => ({ kind: "read" as const, result })),
        stopped,
      ]);
      if (outcome.kind === "timeout") break;
      pendingRead = undefined;
      if (outcome.result.done) {
        throw new HardwareTransportError(
          "device-disconnected",
          "The Arduino disconnected while Firelight was reading serial output.",
        );
      }
      if (!isUint8Array(outcome.result.value)) {
        throw new HardwareTransportError(
          "serial-read-failed",
          "The board returned invalid serial data.",
        );
      }
      const remaining = maxBytes - bytesRead;
      const accepted = outcome.result.value.subarray(0, remaining);
      if (accepted.byteLength < outcome.result.value.byteLength) truncated = true;
      bytesRead += accepted.byteLength;
      const text = decoder.decode(accepted, { stream: true });
      if (text.length > 0) {
        chunks.push(text);
        try {
          onData(text);
        } catch {
          // A rendering callback must not retain the serial reader lock.
        }
      }
      if (truncated || bytesRead >= maxBytes) {
        truncated = true;
        break;
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      chunks.push(tail);
      try {
        onData(tail);
      } catch {
        // A rendering callback must not retain the serial reader lock.
      }
    }
    captured = { text: chunks.join(""), bytesRead, truncated };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (pendingRead) {
      readerCancelled = true;
      await Promise.allSettled([
        reader.cancel("serial-capture-complete"),
        pendingRead,
      ]);
    }
    reader.releaseLock();
  }
  return { ...captured, readerCancelled };
}

const ALLOWED_TRANSITIONS: Readonly<Record<HardwareWorkflowPhase, ReadonlySet<HardwareWorkflowPhase>>> = {
  idle: new Set(["connecting", "error"]),
  compiling: new Set(["idle", "error"]),
  compiled: new Set(["connecting", "idle", "error"]),
  connecting: new Set(["connected", "idle", "error"]),
  connected: new Set(["uploading", "idle", "error"]),
  uploading: new Set(["success", "idle", "error"]),
  success: new Set(["uploading", "idle", "error"]),
  error: new Set(["connecting", "idle"]),
};

export function currentBrowserSerialEnvironment(): BrowserSerialEnvironment {
  const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
  const serial = (
    browserNavigator as (Navigator & { readonly serial?: WebSerialLike }) | undefined
  )?.serial;
  const base = {
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    userAgent: browserNavigator?.userAgent ?? "",
  };
  return serial ? { ...base, serial } : base;
}

export function getHardwareCapabilityGuidance(capability: HardwareCapability): string {
  if (capability.supported) {
    return "Connect the board by USB, then choose its serial port in desktop Chrome or Edge.";
  }
  switch (capability.reason) {
    case "mobile-device":
      return "Use Firelight on desktop Chrome or Edge to connect an Arduino by USB.";
    case "not-secure-context":
      return "Open Firelight over HTTPS (or localhost during development) before connecting a board.";
    case "web-serial-unavailable":
    default:
      return "Web Serial requires a current desktop Chrome or Microsoft Edge browser.";
  }
}

function classifyCapability(environment: BrowserSerialEnvironment): HardwareCapability {
  if (/Android|iPad|iPhone|iPod|Mobi/i.test(environment.userAgent)) {
    return { supported: false, reason: "mobile-device" };
  }
  if (!environment.secureContext) {
    return { supported: false, reason: "not-secure-context" };
  }
  if (!environment.serial) {
    return { supported: false, reason: "web-serial-unavailable" };
  }
  return { supported: true };
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError(fallback);
}

// AbortSignal.aborted is typed readonly even though its value changes asynchronously.
function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isPickerCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { readonly name?: unknown }).name;
  return name === "NotFoundError" || name === "AbortError";
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  fallback: string,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal, fallback);
  let listener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => {
      reject(abortReason(signal, fallback));
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

function formatUsbId(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function metadataFor(port: WebSerialPortLike): ArduinoDeviceMetadata {
  const info = port.getInfo();
  const ids =
    info.usbVendorId === undefined
      ? ""
      : info.usbProductId === undefined
        ? ` (USB vendor ${formatUsbId(info.usbVendorId)})`
        : ` (USB ${formatUsbId(info.usbVendorId)}:${formatUsbId(info.usbProductId)})`;
  return {
    ...(info.usbVendorId === undefined ? {} : { usbVendorId: info.usbVendorId }),
    ...(info.usbProductId === undefined ? {} : { usbProductId: info.usbProductId }),
    displayName: `Selected serial device${ids}`,
  };
}

/** Web Serial transport for the Firelight Nano old-bootloader board profile. */
export class WebSerialArduinoTransport implements ArduinoTransport {
  private readonly environment: BrowserSerialEnvironment;
  private readonly digestHex: Sha256Digest | undefined;
  private readonly uploader: Stk500Uploader;
  private readonly uploaderOptions: Stk500UploadOptions | undefined;
  private readonly now: () => Date;
  private readonly listeners = new Set<(phase: HardwareWorkflowPhase) => void>();
  private readonly physicallyDisconnected = new WeakSet<WebSerialPortLike>();
  private readonly closeOperations = new WeakMap<WebSerialPortLike, Promise<void>>();
  private currentConnection: OpenConnection | undefined;
  private closeRetryPort: WebSerialPortLike | undefined;
  private operationAbort: AbortController | undefined;
  private activeOperation: Promise<unknown> | undefined;
  private currentPhase: HardwareWorkflowPhase = "idle";

  constructor(options: WebSerialArduinoTransportOptions = {}) {
    this.environment = options.environment ?? currentBrowserSerialEnvironment();
    this.digestHex = options.digestHex;
    this.uploader = options.uploader ?? uploadStk500v1;
    this.uploaderOptions = options.uploaderOptions;
    this.now = options.now ?? (() => new Date());
  }

  get phase(): HardwareWorkflowPhase {
    return this.currentPhase;
  }

  detectCapability(): HardwareCapability {
    return classifyCapability(this.environment);
  }

  connect(signal?: AbortSignal): Promise<ArduinoDeviceMetadata> {
    if (this.activeOperation) {
      return Promise.reject(
        new HardwareTransportError(
          "operation-in-progress",
          "Another board operation is already in progress.",
        ),
      );
    }
    if (this.currentConnection) return Promise.resolve(this.currentConnection.metadata);

    const capability = this.detectCapability();
    if (!capability.supported) {
      this.transition("error");
      return Promise.reject(
        new HardwareTransportError(
          capability.reason ?? "web-serial-unavailable",
          getHardwareCapabilityGuidance(capability),
        ),
      );
    }

    const serial = this.environment.serial;
    if (!serial) {
      this.transition("error");
      return Promise.reject(
        new HardwareTransportError(
          "web-serial-unavailable",
          getHardwareCapabilityGuidance({
            supported: false,
            reason: "web-serial-unavailable",
          }),
        ),
      );
    }
    this.transition("connecting");
    return this.runOperation(signal, (operationSignal) =>
      this.connectInternal(serial, operationSignal),
    );
  }

  async disconnect(): Promise<void> {
    await this.stopAndClose("The board was disconnected.");
  }

  async cancel(): Promise<void> {
    await this.stopAndClose("The board operation was cancelled.");
  }

  async validateArtifact(artifact: CompileArtifact): Promise<void> {
    await validateCompileArtifact(artifact, {
      ...(this.digestHex ? { digestHex: this.digestHex } : {}),
    });
  }

  upload(
    artifact: CompileArtifact,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    if (this.activeOperation) {
      return Promise.reject(
        new HardwareTransportError(
          "operation-in-progress",
          "Another board operation is already in progress.",
        ),
      );
    }
    const connection = this.currentConnection;
    if (!connection) {
      this.transition("error");
      return Promise.reject(
        new HardwareTransportError(
          "device-not-connected",
          "Connect the Arduino before sending a sketch.",
        ),
      );
    }

    this.transition("uploading");
    return this.runOperation(signal, (operationSignal) =>
      this.uploadInternal(connection, artifact, onProgress, operationSignal),
    );
  }

  readSerial(
    options: SerialReadOptions,
    onData: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<SerialReadResult> {
    if (this.activeOperation) {
      return Promise.reject(
        new HardwareTransportError(
          "operation-in-progress",
          "Another board operation is already in progress.",
        ),
      );
    }
    const connection = this.currentConnection;
    if (!connection) {
      this.transition("error");
      return Promise.reject(
        new HardwareTransportError(
          "device-not-connected",
          "Reconnect the Arduino before reading serial output.",
        ),
      );
    }
    if (!isSupportedSerialBaud(options.baudRate)) {
      return Promise.reject(
        new TypeError(`Firelight serial checks require ${String(FIRELIGHT_SERIAL_BAUD)} baud.`),
      );
    }

    let durationMs: number;
    let maxBytes: number;
    try {
      durationMs = boundedPositiveInteger(
        options.durationMs,
        DEFAULT_SERIAL_CAPTURE_DURATION_MS,
        MAX_SERIAL_CAPTURE_DURATION_MS,
        "Serial capture duration",
      );
      maxBytes = boundedPositiveInteger(
        options.maxBytes,
        DEFAULT_SERIAL_CAPTURE_BYTES,
        MAX_SERIAL_CAPTURE_BYTES,
        "Serial capture byte limit",
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new TypeError("The serial capture limits are invalid."),
      );
    }

    return this.runOperation(signal, (operationSignal) =>
      this.readSerialInternal(
        connection,
        options.baudRate,
        durationMs,
        maxBytes,
        onData,
        operationSignal,
      ),
    );
  }

  subscribe(listener: (phase: HardwareWorkflowPhase) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private runOperation<T>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let externalAbortListener: (() => void) | undefined;
    if (externalSignal?.aborted) {
      controller.abort(abortReason(externalSignal, "The board operation was cancelled."));
    } else if (externalSignal) {
      externalAbortListener = () => {
        controller.abort(abortReason(externalSignal, "The board operation was cancelled."));
      };
      externalSignal.addEventListener("abort", externalAbortListener, { once: true });
    }
    this.operationAbort = controller;

    const tracked = operation(controller.signal).finally(() => {
      if (externalSignal && externalAbortListener) {
        externalSignal.removeEventListener("abort", externalAbortListener);
      }
      if (this.activeOperation === tracked) {
        this.activeOperation = undefined;
        this.operationAbort = undefined;
      }
    });
    this.activeOperation = tracked;
    return tracked;
  }

  private async connectInternal(
    serial: WebSerialLike,
    signal: AbortSignal,
  ): Promise<ArduinoDeviceMetadata> {
    let selectedPort: WebSerialPortLike | undefined;
    let opened = false;
    try {
      if (signalIsAborted(signal)) {
        throw abortReason(signal, "Board connection was cancelled.");
      }
      await this.retryRetainedClose();
      if (signalIsAborted(signal)) {
        throw abortReason(signal, "Board connection was cancelled.");
      }
      const request = serial.requestPort();
      try {
        selectedPort = await abortable(request, signal, "Board connection was cancelled.");
      } catch (error) {
        if (signalIsAborted(signal)) {
          void request.then(
            (latePort) => this.closePortBestEffort(latePort, false),
            () => undefined,
          );
        }
        throw error;
      }

      const open = selectedPort.open(serialOpenOptions(FIRELIGHT_UPLOAD_BAUD));
      try {
        await abortable(open, signal, "Board connection was cancelled.");
        opened = true;
      } catch (error) {
        if (signalIsAborted(signal)) {
          const latePort = selectedPort;
          void open.then(
            () => this.closePortBestEffort(latePort, true),
            () => undefined,
          );
        }
        throw error;
      }

      if (signalIsAborted(signal)) {
        throw abortReason(signal, "Board connection was cancelled.");
      }
      this.physicallyDisconnected.delete(selectedPort);
      const metadata = metadataFor(selectedPort);
      const connection: OpenConnection = {
        port: selectedPort,
        metadata,
        detachDisconnectListeners: this.attachDisconnectListeners(serial, selectedPort),
        baudRate: FIRELIGHT_UPLOAD_BAUD,
      };
      this.currentConnection = connection;
      this.transition("connected");
      return metadata;
    } catch (error) {
      if (selectedPort) await this.closePortBestEffort(selectedPort, opened);
      if (signalIsAborted(signal) || isAbortError(error) || isPickerCancellation(error)) {
        this.transition("idle");
        if (isPickerCancellation(error) && !signalIsAborted(signal)) {
          throw new HardwareTransportError(
            "connection-cancelled",
            "No serial device was selected.",
            error,
          );
        }
        throw abortReason(signal, "Board connection was cancelled.");
      }
      this.transition("error");
      if (error instanceof HardwareTransportError) throw error;
      throw new HardwareTransportError(
        "connection-failed",
        "The serial port could not be opened. Check the USB data cable and close other serial tools.",
        error,
      );
    }
  }

  private async uploadInternal(
    connection: OpenConnection,
    artifact: CompileArtifact,
    onProgress: (progress: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<UploadResult> {
    try {
      if (signalIsAborted(signal)) throw abortReason(signal, "Board upload was cancelled.");
      const image = await validateCompileArtifact(artifact, {
        ...(this.digestHex ? { digestHex: this.digestHex } : {}),
      });
      if (signalIsAborted(signal)) throw abortReason(signal, "Board upload was cancelled.");
      await this.ensureConnectionBaud(connection, FIRELIGHT_UPLOAD_BAUD, signal);
      if (signalIsAborted(signal)) throw abortReason(signal, "Board upload was cancelled.");
      const result = await this.uploader(
        connection.port,
        image.data,
        onProgress,
        signal,
        this.uploaderOptions,
      );
      if (this.physicallyDisconnected.has(connection.port)) {
        throw new HardwareTransportError(
          "device-disconnected",
          "The Arduino was unplugged during upload.",
        );
      }
      this.transition("success");
      return {
        bytesWritten: result.bytesWritten,
        completedAt: this.now().toISOString(),
      };
    } catch (error) {
      this.clearConnection(connection);
      await this.closePortBestEffort(connection.port, true);
      if (this.physicallyDisconnected.has(connection.port)) {
        this.transition("error");
        throw new HardwareTransportError(
          "device-disconnected",
          "The Arduino was unplugged during upload.",
          error,
        );
      }
      if (signalIsAborted(signal) || isAbortError(error)) {
        this.transition("idle");
        throw abortReason(signal, "Board upload was cancelled.");
      }
      this.transition("error");
      if (error instanceof HardwareTransportError) throw error;
      throw new HardwareTransportError(
        "upload-failed",
        "The sketch could not be verified on the Arduino. Reconnect it and try again.",
        error,
      );
    }
  }

  private async readSerialInternal(
    connection: OpenConnection,
    baudRate: typeof FIRELIGHT_SERIAL_BAUD,
    durationMs: number,
    maxBytes: number,
    onData: (text: string) => void,
    signal: AbortSignal,
  ): Promise<SerialReadResult> {
    try {
      await this.ensureConnectionBaud(connection, baudRate, signal);
      if (signalIsAborted(signal)) throw abortReason(signal, "Serial reading was cancelled.");
      const captured = await captureSerialText(
        connection.port,
        durationMs,
        maxBytes,
        onData,
        signal,
      );
      if (this.physicallyDisconnected.has(connection.port)) {
        throw new HardwareTransportError(
          "device-disconnected",
          "The Arduino was unplugged while Firelight was reading serial output.",
        );
      }
      // Cancelling a pending Web Serial read closes that readable stream. A
      // close/reopen cycle restores a fresh stream while retaining permission
      // for the same selected port.
      if (captured.readerCancelled) {
        await this.ensureConnectionBaud(connection, baudRate, signal, true);
      }
      return {
        baudRate,
        text: captured.text,
        bytesRead: captured.bytesRead,
        truncated: captured.truncated,
      };
    } catch (error) {
      if (this.physicallyDisconnected.has(connection.port)) {
        this.transition("error");
        throw new HardwareTransportError(
          "device-disconnected",
          "The Arduino was unplugged while Firelight was reading serial output.",
          error,
        );
      }
      if (signalIsAborted(signal) || isAbortError(error)) {
        throw abortReason(signal, "Serial reading was cancelled.");
      }
      this.clearConnection(connection);
      await this.closePortBestEffort(connection.port, true);
      this.transition("error");
      if (error instanceof HardwareTransportError) throw error;
      throw new HardwareTransportError(
        "serial-read-failed",
        "Firelight could not read the board's serial output. Reconnect it and try again.",
        error,
      );
    }
  }

  private async ensureConnectionBaud(
    connection: OpenConnection,
    baudRate: number,
    signal: AbortSignal,
    force = false,
  ): Promise<void> {
    if (!force && connection.baudRate === baudRate) return;
    if (this.currentConnection !== connection) {
      throw new HardwareTransportError(
        "device-not-connected",
        "Reconnect the Arduino before continuing.",
      );
    }

    try {
      await this.closePort(connection.port, true);
    } catch (error) {
      this.clearConnection(connection);
      throw new HardwareTransportError(
        "port-close-failed",
        "The serial port could not switch to the required baud rate.",
        error,
      );
    }
    if (signalIsAborted(signal)) {
      this.clearConnection(connection);
      throw abortReason(signal, "The serial baud change was cancelled.");
    }

    const open = connection.port.open(serialOpenOptions(baudRate));
    try {
      await abortable(open, signal, "The serial baud change was cancelled.");
    } catch (error) {
      this.clearConnection(connection);
      if (signalIsAborted(signal)) {
        void open.then(
          () => this.closePortBestEffort(connection.port, true),
          () => undefined,
        );
        throw abortReason(signal, "The serial baud change was cancelled.");
      }
      await this.closePortBestEffort(connection.port, false);
      throw new HardwareTransportError(
        "connection-failed",
        `The serial port could not reopen at ${String(baudRate)} baud.`,
        error,
      );
    }
    if (this.currentConnection !== connection || this.physicallyDisconnected.has(connection.port)) {
      await this.closePortBestEffort(connection.port, false);
      throw new HardwareTransportError(
        "device-disconnected",
        "The Arduino disconnected while changing serial speed.",
      );
    }
    connection.baudRate = baudRate;
  }

  private async stopAndClose(message: string): Promise<void> {
    this.operationAbort?.abort(createAbortError(message));
    const active = this.activeOperation;
    if (active) {
      try {
        await active;
      } catch {
        // The caller requested this cancellation; cleanup errors are handled below.
      }
    }

    const connection = this.currentConnection;
    const port = connection?.port ?? this.closeRetryPort;
    if (!port) {
      if (this.currentPhase !== "idle") this.transition("idle");
      return;
    }
    if (connection) this.clearConnection(connection);
    try {
      await this.closePort(port, true);
      this.transition("idle");
    } catch (error) {
      this.transition("error");
      throw new HardwareTransportError(
        "port-close-failed",
        "The serial port could not be closed cleanly.",
        error,
      );
    }
  }

  private attachDisconnectListeners(
    serial: WebSerialLike,
    port: WebSerialPortLike,
  ): () => void {
    const onPortDisconnect: SerialDisconnectListener = () => {
      this.handlePhysicalDisconnect(port);
    };
    const onSerialDisconnect: SerialDisconnectListener = (event) => {
      const eventPort =
        event.port ?? ((event.target as unknown) === port ? port : undefined);
      if (eventPort === port) this.handlePhysicalDisconnect(port);
    };
    port.addEventListener?.("disconnect", onPortDisconnect);
    serial.addEventListener?.("disconnect", onSerialDisconnect);
    return () => {
      port.removeEventListener?.("disconnect", onPortDisconnect);
      serial.removeEventListener?.("disconnect", onSerialDisconnect);
    };
  }

  private handlePhysicalDisconnect(port: WebSerialPortLike): void {
    const connection = this.currentConnection;
    if (connection?.port !== port) {
      if (this.closeRetryPort === port) {
        this.physicallyDisconnected.add(port);
        this.closeRetryPort = undefined;
      }
      return;
    }
    this.physicallyDisconnected.add(port);
    this.clearConnection(connection);
    const error = new HardwareTransportError(
      "device-disconnected",
      "The Arduino was unplugged. Reconnect it before trying again.",
    );
    this.operationAbort?.abort(error);
    this.transition("error");
    if (!this.activeOperation) void this.closePortBestEffort(port, false);
  }

  private clearConnection(connection: OpenConnection): void {
    connection.detachDisconnectListeners();
    if (this.currentConnection === connection) this.currentConnection = undefined;
  }

  private async retryRetainedClose(): Promise<void> {
    const port = this.closeRetryPort;
    if (!port) return;
    try {
      await this.closePort(port, true);
    } catch (error) {
      throw new HardwareTransportError(
        "port-close-failed",
        "Firelight could not finish closing the previous serial connection.",
        error,
      );
    }
  }

  private closePort(port: WebSerialPortLike, retainOnFailure: boolean): Promise<void> {
    const active = this.closeOperations.get(port);
    if (active) return active;
    if (retainOnFailure && !this.physicallyDisconnected.has(port)) {
      this.closeRetryPort = port;
    }
    const closing = Promise.resolve().then(() => port.close()).then(
      () => {
        if (this.closeRetryPort === port) this.closeRetryPort = undefined;
      },
      (error: unknown) => {
        if (this.physicallyDisconnected.has(port) || !retainOnFailure) {
          if (this.closeRetryPort === port) this.closeRetryPort = undefined;
        } else {
          this.closeRetryPort = port;
        }
        throw error;
      },
    ).finally(() => {
      this.closeOperations.delete(port);
    });
    this.closeOperations.set(port, closing);
    return closing;
  }

  private async closePortBestEffort(
    port: WebSerialPortLike,
    retainOnFailure: boolean,
  ): Promise<void> {
    try {
      await this.closePort(port, retainOnFailure);
    } catch {
      // Preserve the operation failure. A non-physical failed close retains the
      // port so disconnect(), dispose(), or the next connect() can retry it.
    }
  }

  private transition(next: HardwareWorkflowPhase): void {
    if (next === this.currentPhase) return;
    if (!ALLOWED_TRANSITIONS[this.currentPhase].has(next)) {
      throw new Error(`Invalid hardware transition: ${this.currentPhase} -> ${next}`);
    }
    this.currentPhase = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // A view subscriber must not corrupt the transport or leak an open port.
      }
    }
  }
}

export type { SerialDisconnectEventLike };
