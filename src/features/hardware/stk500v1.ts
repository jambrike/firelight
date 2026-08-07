import type { UploadProgress } from "./contracts";
import { createAbortError, isAbortError } from "./errors";
import { FIRELIGHT_MAX_SKETCH_BYTES } from "./intel-hex";
import type {
  SerialReadableReaderLike,
  SerialWritableWriterLike,
  WebSerialPortLike,
} from "./serial-types";

const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const CRC_EOP = 0x20;
const STK_GET_SYNC = 0x30;
const STK_ENTER_PROGMODE = 0x50;
const STK_LEAVE_PROGMODE = 0x51;
const STK_LOAD_ADDRESS = 0x55;
const STK_PROG_PAGE = 0x64;
const STK_READ_PAGE = 0x74;
const STK_MEMORY_FLASH = 0x46;

export type Stk500ErrorCode =
  | "invalid-image"
  | "serial-unavailable"
  | "serial-timeout"
  | "serial-disconnected"
  | "protocol-rejected"
  | "sync-failed"
  | "verification-failed";

export class Stk500ProtocolError extends Error {
  readonly code: Stk500ErrorCode;

  constructor(code: Stk500ErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "Stk500ProtocolError";
    this.code = code;
  }
}

export interface Stk500UploadOptions {
  readonly pageSize?: number;
  readonly syncAttempts?: number;
  readonly resetLowMs?: number;
  readonly resetHighMs?: number;
  readonly syncRetryDelayMs?: number;
  readonly syncTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly pageTimeoutMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface ResolvedOptions {
  readonly pageSize: number;
  readonly syncAttempts: number;
  readonly resetLowMs: number;
  readonly resetHighMs: number;
  readonly syncRetryDelayMs: number;
  readonly syncTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly pageTimeoutMs: number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createAbortError("The board upload was cancelled.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function resolveOptions(options: Stk500UploadOptions): ResolvedOptions {
  const pageSize = positiveInteger(options.pageSize ?? 128, "pageSize");
  if (pageSize > 256 || pageSize % 2 !== 0) {
    throw new TypeError("pageSize must be an even value no larger than 256 bytes.");
  }
  return {
    pageSize,
    syncAttempts: positiveInteger(options.syncAttempts ?? 8, "syncAttempts"),
    resetLowMs: nonNegativeInteger(options.resetLowMs ?? 80, "resetLowMs"),
    resetHighMs: nonNegativeInteger(options.resetHighMs ?? 350, "resetHighMs"),
    syncRetryDelayMs: nonNegativeInteger(
      options.syncRetryDelayMs ?? 80,
      "syncRetryDelayMs",
    ),
    syncTimeoutMs: positiveInteger(options.syncTimeoutMs ?? 500, "syncTimeoutMs"),
    commandTimeoutMs: positiveInteger(
      options.commandTimeoutMs ?? 1_000,
      "commandTimeoutMs",
    ),
    pageTimeoutMs: positiveInteger(options.pageTimeoutMs ?? 2_000, "pageTimeoutMs"),
    sleep: options.sleep ?? defaultSleep,
  };
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => {
        reject(new Stk500ProtocolError("serial-timeout", "The bootloader timed out."));
      },
      timeoutMs,
    );
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

class SerialByteQueue {
  private readonly queue: number[] = [];
  private pendingRead: Promise<void> | undefined;

  constructor(private readonly reader: SerialReadableReaderLike) {}

  async readByte(timeoutMs: number, signal: AbortSignal): Promise<number> {
    while (this.queue.length === 0) {
      throwIfAborted(signal);
      const pending = this.pendingRead ?? this.startRead();
      await withDeadline(pending, timeoutMs, signal);
    }
    const byte = this.queue.shift();
    if (byte === undefined) {
      throw new Stk500ProtocolError("serial-disconnected", "The serial device disconnected.");
    }
    return byte;
  }

  async cancelPending(reason: unknown): Promise<void> {
    if (!this.pendingRead) return;
    try {
      await this.reader.cancel(reason);
    } catch {
      // The port may already have been physically removed.
    }
    try {
      await this.pendingRead;
    } catch {
      // The original operation error remains authoritative.
    }
  }

  private startRead(): Promise<void> {
    const pending = this.reader.read().then(({ value, done }) => {
      if (done) {
        throw new Stk500ProtocolError(
          "serial-disconnected",
          "The serial device disconnected.",
        );
      }
      this.queue.push(...value);
    });
    this.pendingRead = pending.finally(() => {
      this.pendingRead = undefined;
    });
    return this.pendingRead;
  }
}

class Stk500Client {
  private readonly input: SerialByteQueue;

  constructor(
    private readonly reader: SerialReadableReaderLike,
    private readonly writer: SerialWritableWriterLike,
  ) {
    this.input = new SerialByteQueue(reader);
  }

  async transact(
    payload: readonly number[],
    responseLength: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal);
    const command = Uint8Array.from([...payload, CRC_EOP]);
    try {
      await withDeadline(this.writer.write(command), timeoutMs, signal);
    } catch (error) {
      if (error instanceof Stk500ProtocolError && error.code === "serial-timeout") {
        try {
          await this.writer.abort(error);
        } catch {
          // Cleanup below will release the writer even after a failed abort.
        }
      }
      throw error;
    }

    const first = await this.input.readByte(timeoutMs, signal);
    if (first !== STK_INSYNC) {
      throw new Stk500ProtocolError(
        "protocol-rejected",
        `The bootloader rejected a command (status 0x${first.toString(16).padStart(2, "0")}).`,
      );
    }

    const response = new Uint8Array(responseLength);
    for (let index = 0; index < response.length; index += 1) {
      response[index] = await this.input.readByte(timeoutMs, signal);
    }
    const status = await this.input.readByte(timeoutMs, signal);
    if (status !== STK_OK) {
      throw new Stk500ProtocolError(
        "protocol-rejected",
        `The bootloader did not complete a command (status 0x${status.toString(16).padStart(2, "0")}).`,
      );
    }
    return response;
  }

  async dispose(cancelPending: boolean, reason?: unknown): Promise<void> {
    if (cancelPending) {
      await Promise.allSettled([
        this.input.cancelPending(reason),
        this.writer.abort(reason),
      ]);
    }
    try {
      this.reader.releaseLock();
    } finally {
      this.writer.releaseLock();
    }
  }
}

export interface Stk500UploadResult {
  readonly bytesWritten: number;
}

/** Programs and reads back an ATmega328P image using the Nano old-bootloader protocol. */
export async function uploadStk500v1(
  port: WebSerialPortLike,
  image: Uint8Array,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
  options: Stk500UploadOptions = {},
): Promise<Stk500UploadResult> {
  if (!(image instanceof Uint8Array) || image.length === 0 || image.length > FIRELIGHT_MAX_SKETCH_BYTES) {
    throw new Stk500ProtocolError("invalid-image", "The flash image size is invalid.");
  }
  const resolved = resolveOptions(options);
  throwIfAborted(signal);

  const writable = port.writable;
  if (!writable) {
    throw new Stk500ProtocolError("serial-unavailable", "The serial output stream is unavailable.");
  }
  const writer = writable.getWriter();
  let reader: SerialReadableReaderLike | undefined;
  let client: Stk500Client | undefined;
  let succeeded = false;

  try {
    const readable = port.readable;
    if (!readable) {
      throw new Stk500ProtocolError("serial-unavailable", "The serial input stream is unavailable.");
    }
    reader = readable.getReader();
    client = new Stk500Client(reader, writer);

    const totalBytes = image.length;
    onProgress({ phase: "preparing", bytesWritten: 0, totalBytes });
    onProgress({ phase: "resetting", bytesWritten: 0, totalBytes });
    await withDeadline(
      port.setSignals({ dataTerminalReady: false, requestToSend: false }),
      resolved.commandTimeoutMs,
      signal,
    );
    await resolved.sleep(resolved.resetLowMs, signal);
    await withDeadline(
      port.setSignals({ dataTerminalReady: true, requestToSend: true }),
      resolved.commandTimeoutMs,
      signal,
    );
    await resolved.sleep(resolved.resetHighMs, signal);

    let syncError: unknown;
    for (let attempt = 0; attempt < resolved.syncAttempts; attempt += 1) {
      try {
        await client.transact([STK_GET_SYNC], 0, resolved.syncTimeoutMs, signal);
        syncError = undefined;
        break;
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (
          error instanceof Stk500ProtocolError &&
          error.code === "serial-disconnected"
        ) {
          throw error;
        }
        syncError = error;
        if (attempt + 1 < resolved.syncAttempts) {
          await resolved.sleep(resolved.syncRetryDelayMs, signal);
        }
      }
    }
    if (syncError !== undefined) {
      throw new Stk500ProtocolError(
        "sync-failed",
        "Could not synchronize with the Arduino bootloader.",
        syncError,
      );
    }

    await client.transact([STK_ENTER_PROGMODE], 0, resolved.commandTimeoutMs, signal);
    onProgress({ phase: "writing", bytesWritten: 0, totalBytes });

    for (let offset = 0; offset < image.length; offset += resolved.pageSize) {
      const page = image.slice(offset, offset + resolved.pageSize);
      const wordAddress = offset >>> 1;
      await client.transact(
        [STK_LOAD_ADDRESS, wordAddress & 0xff, (wordAddress >>> 8) & 0xff],
        0,
        resolved.commandTimeoutMs,
        signal,
      );
      await client.transact(
        [
          STK_PROG_PAGE,
          (page.length >>> 8) & 0xff,
          page.length & 0xff,
          STK_MEMORY_FLASH,
          ...page,
        ],
        0,
        resolved.pageTimeoutMs,
        signal,
      );
      onProgress({
        phase: "writing",
        bytesWritten: Math.min(offset + page.length, totalBytes),
        totalBytes,
      });
    }

    onProgress({ phase: "verifying", bytesWritten: totalBytes, totalBytes });
    for (let offset = 0; offset < image.length; offset += resolved.pageSize) {
      const expected = image.slice(offset, offset + resolved.pageSize);
      const wordAddress = offset >>> 1;
      await client.transact(
        [STK_LOAD_ADDRESS, wordAddress & 0xff, (wordAddress >>> 8) & 0xff],
        0,
        resolved.commandTimeoutMs,
        signal,
      );
      const actual = await client.transact(
        [
          STK_READ_PAGE,
          (expected.length >>> 8) & 0xff,
          expected.length & 0xff,
          STK_MEMORY_FLASH,
        ],
        expected.length,
        resolved.pageTimeoutMs,
        signal,
      );
      if (actual.some((byte, index) => byte !== expected[index])) {
        throw new Stk500ProtocolError(
          "verification-failed",
          "Flash verification did not match the compiled artifact.",
        );
      }
    }

    await client.transact([STK_LEAVE_PROGMODE], 0, resolved.commandTimeoutMs, signal);
    succeeded = true;
    return { bytesWritten: totalBytes };
  } finally {
    if (client) {
      await client.dispose(!succeeded, signal.reason);
    } else {
      try {
        reader?.releaseLock();
      } finally {
        writer.releaseLock();
      }
    }
  }
}
