import { validateCompileArtifact, type Sha256Digest } from "./artifact";
import {
  FIRELIGHT_UPLOAD_BAUD,
  type ArduinoDeviceMetadata,
  type ArduinoTransport,
  type CompileArtifact,
  type HardwareCapability,
  type HardwareWorkflowPhase,
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
  private readonly intentionallyClosing = new WeakSet<WebSerialPortLike>();
  private readonly physicallyDisconnected = new WeakSet<WebSerialPortLike>();
  private currentConnection: OpenConnection | undefined;
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
    try {
      if (signalIsAborted(signal)) {
        throw abortReason(signal, "Board connection was cancelled.");
      }
      const request = serial.requestPort();
      try {
        selectedPort = await abortable(request, signal, "Board connection was cancelled.");
      } catch (error) {
        if (signalIsAborted(signal)) {
          void request.then((latePort) => this.closePortBestEffort(latePort), () => undefined);
        }
        throw error;
      }

      const open = selectedPort.open({
        baudRate: FIRELIGHT_UPLOAD_BAUD,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        bufferSize: 255,
        flowControl: "none",
      });
      try {
        await abortable(open, signal, "Board connection was cancelled.");
      } catch (error) {
        if (signalIsAborted(signal)) {
          const latePort = selectedPort;
          void open.then(() => this.closePortBestEffort(latePort), () => undefined);
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
      };
      this.currentConnection = connection;
      this.transition("connected");
      return metadata;
    } catch (error) {
      if (selectedPort) await this.closePortBestEffort(selectedPort);
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
      await this.closePortBestEffort(connection.port);
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
    if (!connection) {
      if (this.currentPhase !== "idle") this.transition("idle");
      return;
    }
    this.clearConnection(connection);
    this.intentionallyClosing.add(connection.port);
    try {
      await connection.port.close();
      this.transition("idle");
    } catch (error) {
      this.transition("error");
      throw new HardwareTransportError(
        "port-close-failed",
        "The serial port could not be closed cleanly.",
        error,
      );
    } finally {
      this.intentionallyClosing.delete(connection.port);
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
    if (this.intentionallyClosing.has(port)) return;
    const connection = this.currentConnection;
    if (connection?.port !== port) return;
    this.physicallyDisconnected.add(port);
    this.clearConnection(connection);
    const error = new HardwareTransportError(
      "device-disconnected",
      "The Arduino was unplugged. Reconnect it before trying again.",
    );
    this.operationAbort?.abort(error);
    this.transition("error");
    if (!this.activeOperation) void this.closePortBestEffort(port);
  }

  private clearConnection(connection: OpenConnection): void {
    connection.detachDisconnectListeners();
    if (this.currentConnection === connection) this.currentConnection = undefined;
  }

  private async closePortBestEffort(port: WebSerialPortLike): Promise<void> {
    this.intentionallyClosing.add(port);
    try {
      await port.close();
    } catch {
      // Preserve the operation failure; close() also rejects after physical removal.
    } finally {
      this.intentionallyClosing.delete(port);
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
