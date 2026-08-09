import type {
  SerialDisconnectEventLike,
  SerialDisconnectListener,
  SerialOpenOptionsLike,
  SerialOutputSignalsLike,
  SerialPortInfoLike,
  SerialReadableLike,
  SerialReadableReaderLike,
  SerialWritableLike,
  SerialWritableWriterLike,
  WebSerialLike,
  WebSerialPortLike,
} from "../serial-types";

const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const STK_NOSYNC = 0x15;
const CRC_EOP = 0x20;

function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (reason instanceof DOMException) {
    const error = new Error(reason.message);
    error.name = reason.name;
    return error;
  }
  return new Error("Mock serial failure.");
}

export function intelHexRecord(
  address: number,
  recordType: number,
  data: readonly number[],
): string {
  const bytes = [
    data.length,
    (address >>> 8) & 0xff,
    address & 0xff,
    recordType,
    ...data,
  ];
  const checksum = (-bytes.reduce((sum, byte) => sum + byte, 0)) & 0xff;
  return `:${[...bytes, checksum]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;
}

export function intelHexDocument(...records: readonly string[]): string {
  return `${records.join("\n")}\n`;
}

interface PendingRead {
  readonly resolve: (result: ReadableStreamReadResult<Uint8Array>) => void;
}

class MockReadable implements SerialReadableLike {
  readonly chunks: Uint8Array[] = [];
  readonly pending: PendingRead[] = [];
  locked = false;
  released = false;
  cancelCount = 0;
  done = false;

  getReader(): SerialReadableReaderLike {
    if (this.locked) throw new TypeError("Readable stream is already locked.");
    this.locked = true;
    return {
      read: () => this.read(),
      cancel: async () => this.cancel(),
      releaseLock: () => {
        this.locked = false;
        this.released = true;
      },
    };
  }

  enqueue(data: Uint8Array): void {
    if (this.done) return;
    const waiter = this.pending.shift();
    if (waiter) waiter.resolve({ value: data, done: false });
    else this.chunks.push(data);
  }

  end(): void {
    this.done = true;
    for (const waiter of this.pending.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  reset(): void {
    this.done = false;
  }

  private read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve({ value: chunk, done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.pending.push({ resolve }));
  }

  private cancel(): Promise<void> {
    this.cancelCount += 1;
    this.end();
    return Promise.resolve();
  }
}

class MockWritable implements SerialWritableLike {
  locked = false;
  released = false;
  abortCount = 0;

  constructor(private readonly onWrite: (data: Uint8Array) => void | Promise<void>) {}

  getWriter(): SerialWritableWriterLike {
    if (this.locked) throw new TypeError("Writable stream is already locked.");
    this.locked = true;
    return {
      write: (data) => Promise.resolve(this.onWrite(data)),
      abort: () => {
        this.abortCount += 1;
        return Promise.resolve();
      },
      releaseLock: () => {
        this.locked = false;
        this.released = true;
      },
    };
  }
}

export interface MockSerialPortOptions {
  readonly info?: SerialPortInfoLike;
  readonly syncFailures?: number;
  readonly fragmentResponses?: boolean;
  readonly corruptVerification?: boolean;
  readonly ignoreCommand?: number;
  readonly openError?: unknown;
  readonly closeError?: unknown;
  readonly closeFailures?: number;
  readonly signature?: readonly number[];
}

export class MockSerialPort implements WebSerialPortLike {
  readonly flash = new Uint8Array(30_720).fill(0xff);
  readonly commands: Uint8Array[] = [];
  readonly signalChanges: SerialOutputSignalsLike[] = [];
  readonly readableMock = new MockReadable();
  readonly writableMock = new MockWritable((data) => this.handleWrite(data));
  readonly readable: SerialReadableLike = this.readableMock;
  readonly writable: SerialWritableLike = this.writableMock;
  readonly openCalls: SerialOpenOptionsLike[] = [];
  closeCount = 0;
  closeWhileLocked = false;
  opened = false;
  private readonly listeners = new Set<SerialDisconnectListener>();
  private readonly info: SerialPortInfoLike;
  private syncFailures: number;
  private readonly fragmentResponses: boolean;
  private readonly corruptVerification: boolean;
  private readonly ignoreCommand: number | undefined;
  private readonly openError: unknown;
  private readonly closeError: unknown;
  private remainingCloseFailures: number;
  private readonly signature: readonly number[];
  private wordAddress = 0;

  constructor(options: MockSerialPortOptions = {}) {
    this.info = options.info ?? { usbVendorId: 0x1a86, usbProductId: 0x7523 };
    this.syncFailures = options.syncFailures ?? 0;
    this.fragmentResponses = options.fragmentResponses ?? false;
    this.corruptVerification = options.corruptVerification ?? false;
    this.ignoreCommand = options.ignoreCommand;
    this.openError = options.openError;
    this.closeError = options.closeError;
    this.remainingCloseFailures = options.closeFailures ?? 0;
    this.signature = options.signature ?? [0x1e, 0x95, 0x0f];
  }

  open(options: SerialOpenOptionsLike): Promise<void> {
    this.openCalls.push(options);
    if (this.openError !== undefined) return Promise.reject(asError(this.openError));
    this.readableMock.reset();
    this.opened = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    if (this.readableMock.locked || this.writableMock.locked) {
      this.closeWhileLocked = true;
      return Promise.reject(new Error("Streams must be unlocked before closing the serial port."));
    }
    if (this.remainingCloseFailures > 0) {
      this.remainingCloseFailures -= 1;
      return Promise.reject(new Error("Transient serial close failure."));
    }
    if (this.closeError !== undefined) return Promise.reject(asError(this.closeError));
    this.opened = false;
    return Promise.resolve();
  }

  getInfo(): SerialPortInfoLike {
    return this.info;
  }

  setSignals(signals: SerialOutputSignalsLike): Promise<void> {
    this.signalChanges.push(signals);
    return Promise.resolve();
  }

  addEventListener(_type: "disconnect", listener: SerialDisconnectListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "disconnect", listener: SerialDisconnectListener): void {
    this.listeners.delete(listener);
  }

  physicallyDisconnect(): void {
    this.opened = false;
    this.readableMock.end();
    const event = { target: this } as unknown as SerialDisconnectEventLike;
    for (const listener of this.listeners) listener(event);
  }

  enqueueSerialText(text: string): void {
    this.readableMock.enqueue(new TextEncoder().encode(text));
  }

  private handleWrite(encodedCommand: Uint8Array): Promise<void> {
    const payload = encodedCommand.slice(0, -1);
    if (encodedCommand.at(-1) !== CRC_EOP || payload.length === 0) {
      return Promise.reject(new Error("Malformed STK500 command."));
    }
    this.commands.push(payload);
    const command = payload[0];
    if (command === this.ignoreCommand) return Promise.resolve();

    switch (command) {
      case 0x30:
        if (this.syncFailures > 0) {
          this.syncFailures -= 1;
          this.respond([STK_NOSYNC]);
        } else {
          this.respond([STK_INSYNC, STK_OK]);
        }
        break;
      case 0x50:
      case 0x51:
        this.respond([STK_INSYNC, STK_OK]);
        break;
      case 0x75:
        this.respond([STK_INSYNC, ...this.signature, STK_OK]);
        break;
      case 0x55:
        this.wordAddress = (payload[1] ?? 0) | ((payload[2] ?? 0) << 8);
        this.respond([STK_INSYNC, STK_OK]);
        break;
      case 0x64: {
        const length = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
        const page = payload.slice(4, 4 + length);
        this.flash.set(page, this.wordAddress * 2);
        this.respond([STK_INSYNC, STK_OK]);
        break;
      }
      case 0x74: {
        const length = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
        const page = this.flash.slice(this.wordAddress * 2, this.wordAddress * 2 + length);
        if (this.corruptVerification && page.length > 0) {
          page[0] = (page[0] ?? 0) ^ 0xff;
        }
        this.respond([STK_INSYNC, ...page, STK_OK]);
        break;
      }
      default:
        this.respond([STK_NOSYNC]);
    }
    return Promise.resolve();
  }

  private respond(bytes: readonly number[]): void {
    if (this.fragmentResponses) {
      for (const byte of bytes) this.readableMock.enqueue(Uint8Array.of(byte));
    } else {
      this.readableMock.enqueue(Uint8Array.from(bytes));
    }
  }
}

export class MockWebSerial implements WebSerialLike {
  requestCount = 0;
  private readonly listeners = new Set<SerialDisconnectListener>();

  constructor(
    readonly port: WebSerialPortLike,
    private readonly requestError?: unknown,
  ) {}

  requestPort(): Promise<WebSerialPortLike> {
    this.requestCount += 1;
    if (this.requestError !== undefined) return Promise.reject(asError(this.requestError));
    return Promise.resolve(this.port);
  }

  addEventListener(_type: "disconnect", listener: SerialDisconnectListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "disconnect", listener: SerialDisconnectListener): void {
    this.listeners.delete(listener);
  }

  emitDisconnect(port: WebSerialPortLike = this.port): void {
    const event = { port, target: port } as unknown as SerialDisconnectEventLike;
    for (const listener of this.listeners) listener(event);
  }
}

export class DeferredMockWebSerial implements WebSerialLike {
  requestCount = 0;
  private resolveRequest: ((port: WebSerialPortLike) => void) | undefined;
  private readonly request = new Promise<WebSerialPortLike>((resolve) => {
    this.resolveRequest = resolve;
  });

  requestPort(): Promise<WebSerialPortLike> {
    this.requestCount += 1;
    return this.request;
  }

  resolve(port: WebSerialPortLike): void {
    this.resolveRequest?.(port);
    this.resolveRequest = undefined;
  }
}

export const immediateSleep = (
  _milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError"),
    );
  }
  return Promise.resolve();
};
