export interface SerialPortInfoLike {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
}

export interface SerialOpenOptionsLike {
  readonly baudRate: number;
  readonly dataBits?: 7 | 8;
  readonly stopBits?: 1 | 2;
  readonly parity?: "none" | "even" | "odd";
  readonly bufferSize?: number;
  readonly flowControl?: "none" | "hardware";
}

export interface SerialOutputSignalsLike {
  readonly dataTerminalReady?: boolean;
  readonly requestToSend?: boolean;
  readonly break?: boolean;
}

export interface SerialReadableReaderLike {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface SerialWritableWriterLike {
  write(data: Uint8Array): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface SerialReadableLike {
  getReader(): SerialReadableReaderLike;
}

export interface SerialWritableLike {
  getWriter(): SerialWritableWriterLike;
}

export interface SerialDisconnectEventLike extends Event {
  readonly port?: WebSerialPortLike;
}

export type SerialDisconnectListener = (event: SerialDisconnectEventLike) => void;

export interface WebSerialPortLike {
  readonly readable: SerialReadableLike | null;
  readonly writable: SerialWritableLike | null;
  open(options: SerialOpenOptionsLike): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLike;
  setSignals(signals: SerialOutputSignalsLike): Promise<void>;
  addEventListener?(type: "disconnect", listener: SerialDisconnectListener): void;
  removeEventListener?(type: "disconnect", listener: SerialDisconnectListener): void;
}

export interface WebSerialLike {
  requestPort(): Promise<WebSerialPortLike>;
  addEventListener?(type: "disconnect", listener: SerialDisconnectListener): void;
  removeEventListener?(type: "disconnect", listener: SerialDisconnectListener): void;
}
