import { describe, expect, it, vi } from "vitest";
import type { UploadProgress } from "./contracts";
import type { Stk500ProtocolError } from "./stk500v1";
import { uploadStk500v1 } from "./stk500v1";
import { immediateSleep, MockSerialPort } from "./testing/serial-mock";

const FAST_OPTIONS = {
  sleep: immediateSleep,
  syncTimeoutMs: 25,
  commandTimeoutMs: 25,
  pageTimeoutMs: 25,
} as const;

describe("STK500v1 uploader", () => {
  it("resets, writes page-addressed flash, reads it back, and reports progress", async () => {
    const port = new MockSerialPort({ fragmentResponses: true });
    const image = Uint8Array.from({ length: 130 }, (_value, index) => index & 0xff);
    const progress: UploadProgress[] = [];

    await expect(
      uploadStk500v1(
        port,
        image,
        (event) => progress.push(event),
        new AbortController().signal,
        FAST_OPTIONS,
      ),
    ).resolves.toEqual({ bytesWritten: 130 });

    expect(port.signalChanges).toEqual([
      { dataTerminalReady: false, requestToSend: false },
      { dataTerminalReady: true, requestToSend: true },
    ]);
    expect([...port.flash.slice(0, image.length)]).toEqual([...image]);
    expect(port.commands.map((command) => command[0])).toEqual([
      0x30,
      0x50,
      0x75,
      0x55,
      0x64,
      0x55,
      0x64,
      0x55,
      0x74,
      0x55,
      0x74,
      0x51,
    ]);
    expect(progress).toEqual([
      { phase: "preparing", bytesWritten: 0, totalBytes: 130 },
      { phase: "resetting", bytesWritten: 0, totalBytes: 130 },
      { phase: "writing", bytesWritten: 0, totalBytes: 130 },
      { phase: "writing", bytesWritten: 128, totalBytes: 130 },
      { phase: "writing", bytesWritten: 130, totalBytes: 130 },
      { phase: "verifying", bytesWritten: 130, totalBytes: 130 },
    ]);
    expect(port.readableMock.released).toBe(true);
    expect(port.writableMock.released).toBe(true);
    expect(port.writableMock.abortCount).toBe(0);
  });

  it("retries synchronization without losing fragmented responses", async () => {
    const port = new MockSerialPort({ syncFailures: 2, fragmentResponses: true });

    await uploadStk500v1(
      port,
      Uint8Array.of(1, 2, 3, 4),
      vi.fn(),
      new AbortController().signal,
      FAST_OPTIONS,
    );

    expect(port.commands.filter((command) => command[0] === 0x30)).toHaveLength(3);
  });

  it("fails closed when read-back verification differs", async () => {
    const port = new MockSerialPort({ corruptVerification: true });

    await expect(
      uploadStk500v1(
        port,
        Uint8Array.of(1, 2, 3, 4),
        vi.fn(),
        new AbortController().signal,
        FAST_OPTIONS,
      ),
    ).rejects.toMatchObject({
      code: "verification-failed" satisfies Stk500ProtocolError["code"],
    });
    expect(port.readableMock.released).toBe(true);
    expect(port.writableMock.released).toBe(true);
    expect(port.writableMock.abortCount).toBe(1);
  });

  it("rejects a STK500 target that is not an ATmega328P before writing flash", async () => {
    const port = new MockSerialPort({ signature: [0x1e, 0x95, 0x14] });

    await expect(
      uploadStk500v1(
        port,
        Uint8Array.of(1, 2, 3, 4),
        vi.fn(),
        new AbortController().signal,
        FAST_OPTIONS,
      ),
    ).rejects.toMatchObject({
      code: "wrong-device" satisfies Stk500ProtocolError["code"],
    });
    expect(port.commands.some((command) => command[0] === 0x64)).toBe(false);
  });

  it("cancels pending reads and releases both locks on cancellation", async () => {
    const port = new MockSerialPort({ ignoreCommand: 0x30 });
    const controller = new AbortController();
    const upload = uploadStk500v1(
      port,
      Uint8Array.of(1, 2),
      vi.fn(),
      controller.signal,
      { ...FAST_OPTIONS, syncTimeoutMs: 10_000 },
    );
    await vi.waitFor(() => {
      expect(port.commands).toHaveLength(1);
    });

    controller.abort(new DOMException("Stop", "AbortError"));

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(port.readableMock.cancelCount).toBe(1);
    expect(port.writableMock.abortCount).toBe(1);
    expect(port.readableMock.released).toBe(true);
    expect(port.writableMock.released).toBe(true);
  });

  it("detects a physical stream disconnect and releases resources", async () => {
    const port = new MockSerialPort({ ignoreCommand: 0x30 });
    const upload = uploadStk500v1(
      port,
      Uint8Array.of(1, 2),
      vi.fn(),
      new AbortController().signal,
      { ...FAST_OPTIONS, syncTimeoutMs: 10_000 },
    );
    await vi.waitFor(() => {
      expect(port.commands).toHaveLength(1);
    });

    port.physicallyDisconnect();

    await expect(upload).rejects.toMatchObject({ code: "serial-disconnected" });
    expect(port.readableMock.released).toBe(true);
    expect(port.writableMock.released).toBe(true);
  });

  it("rejects unsafe image and board settings before locking streams", async () => {
    const port = new MockSerialPort();
    await expect(
      uploadStk500v1(
        port,
        new Uint8Array(),
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-image" });
    await expect(
      uploadStk500v1(
        port,
        Uint8Array.of(1),
        vi.fn(),
        new AbortController().signal,
        { pageSize: 127 },
      ),
    ).rejects.toThrow("pageSize");
    expect(port.readableMock.locked).toBe(false);
    expect(port.writableMock.locked).toBe(false);
  });
});
