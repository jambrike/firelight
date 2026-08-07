import { describe, expect, it, vi } from "vitest";
import type { CompileArtifact, HardwareWorkflowPhase } from "./contracts";
import { FIRELIGHT_BOARD_FQBN, FIRELIGHT_UPLOAD_BAUD } from "./contracts";
import type { HardwareTransportError } from "./errors";
import {
  getHardwareCapabilityGuidance,
  WebSerialArduinoTransport,
  type BrowserSerialEnvironment,
} from "./web-serial";
import {
  DeferredMockWebSerial,
  immediateSleep,
  intelHexDocument,
  intelHexRecord,
  MockSerialPort,
  MockWebSerial,
} from "./testing/serial-mock";

const ARTIFACT_HASH = "b".repeat(64);

function artifact(overrides: Partial<CompileArtifact> = {}): CompileArtifact {
  return {
    compileJobId: "123e4567-e89b-42d3-a456-426614174000",
    format: "intel-hex",
    fqbn: FIRELIGHT_BOARD_FQBN,
    sourceHash: "a".repeat(64),
    artifactHash: ARTIFACT_HASH,
    hex: intelHexDocument(
      intelHexRecord(0, 0x00, [0x0c, 0x94, 0x00, 0x00]),
      intelHexRecord(0, 0x01, []),
    ),
    diagnostics: [],
    ...overrides,
  };
}

function supportedEnvironment(port: MockSerialPort): BrowserSerialEnvironment {
  return {
    secureContext: true,
    userAgent: "Mozilla/5.0 Chrome/140",
    serial: new MockWebSerial(port),
  };
}

function transportFor(port: MockSerialPort): WebSerialArduinoTransport {
  return new WebSerialArduinoTransport({
    environment: supportedEnvironment(port),
    digestHex: async () => ARTIFACT_HASH,
    uploaderOptions: {
      sleep: immediateSleep,
      syncTimeoutMs: 25,
      commandTimeoutMs: 25,
      pageTimeoutMs: 25,
    },
    now: () => new Date("2026-08-07T12:34:56.000Z"),
  });
}

describe("WebSerialArduinoTransport capability and connection", () => {
  it.each([
    [
      { secureContext: true, userAgent: "Mozilla/5.0 (iPhone)" },
      "mobile-device",
      "desktop Chrome or Edge",
    ],
    [
      { secureContext: false, userAgent: "Mozilla/5.0 Chrome/140" },
      "not-secure-context",
      "HTTPS",
    ],
    [
      { secureContext: true, userAgent: "Mozilla/5.0 Firefox/141" },
      "web-serial-unavailable",
      "Microsoft Edge",
    ],
  ] as const)("reports unsupported environments", (environment, reason, guidance) => {
    const transport = new WebSerialArduinoTransport({ environment });
    const capability = transport.detectCapability();
    expect(capability).toEqual({ supported: false, reason });
    expect(getHardwareCapabilityGuidance(capability)).toContain(guidance);
  });

  it("opens at the fixed old-bootloader baud and returns USB metadata", async () => {
    const port = new MockSerialPort({
      info: { usbVendorId: 0x1a86, usbProductId: 0x7523 },
    });
    const serial = new MockWebSerial(port);
    const transport = new WebSerialArduinoTransport({
      environment: {
        secureContext: true,
        userAgent: "Mozilla/5.0 Edg/140",
        serial,
      },
    });
    const phases: HardwareWorkflowPhase[] = [];
    const unsubscribe = transport.subscribe((phase) => phases.push(phase));

    await expect(transport.connect()).resolves.toEqual({
      usbVendorId: 0x1a86,
      usbProductId: 0x7523,
      displayName: "Selected serial device (USB 1A86:7523)",
    });
    expect(port.openCalls).toEqual([
      {
        baudRate: FIRELIGHT_UPLOAD_BAUD,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        bufferSize: 255,
        flowControl: "none",
      },
    ]);
    expect(phases).toEqual(["connecting", "connected"]);
    expect(transport.phase).toBe("connected");
    unsubscribe();

    await transport.disconnect();
    expect(port.closeCount).toBe(1);
    expect(transport.phase).toBe("idle");
    expect(phases).toEqual(["connecting", "connected"]);
  });

  it("returns user cancellation to idle and closes failed-open ports", async () => {
    const cancelledPort = new MockSerialPort();
    const cancelled = new WebSerialArduinoTransport({
      environment: {
        secureContext: true,
        userAgent: "Chrome",
        serial: new MockWebSerial(
          cancelledPort,
          new DOMException("No port selected", "NotFoundError"),
        ),
      },
    });
    await expect(cancelled.connect()).rejects.toMatchObject({
      code: "connection-cancelled",
    });
    expect(cancelled.phase).toBe("idle");

    const failedPort = new MockSerialPort({ openError: new Error("busy") });
    const failed = new WebSerialArduinoTransport({
      environment: supportedEnvironment(failedPort),
    });
    await expect(failed.connect()).rejects.toMatchObject({ code: "connection-failed" });
    expect(failedPort.closeCount).toBe(1);
    expect(failed.phase).toBe("error");
  });

  it("does not prompt for a pre-cancelled connect and closes a late picker result", async () => {
    const preCancelledSerial = new DeferredMockWebSerial();
    const preCancelled = new WebSerialArduinoTransport({
      environment: {
        secureContext: true,
        userAgent: "Chrome",
        serial: preCancelledSerial,
      },
    });
    const preCancelledSignal = new AbortController();
    preCancelledSignal.abort(new DOMException("Stop", "AbortError"));

    await expect(preCancelled.connect(preCancelledSignal.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(preCancelledSerial.requestCount).toBe(0);
    expect(preCancelled.phase).toBe("idle");

    const port = new MockSerialPort();
    const delayedSerial = new DeferredMockWebSerial();
    const delayed = new WebSerialArduinoTransport({
      environment: {
        secureContext: true,
        userAgent: "Chrome",
        serial: delayedSerial,
      },
    });
    const connect = delayed.connect();
    const rejection = expect(connect).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(delayedSerial.requestCount).toBe(1);
    });
    await expect(delayed.connect()).rejects.toMatchObject({
      code: "operation-in-progress",
    });

    await delayed.cancel();
    await rejection;
    delayedSerial.resolve(port);

    await vi.waitFor(() => {
      expect(port.closeCount).toBe(1);
    });
    expect(delayed.phase).toBe("idle");
  });

  it("fails with actionable HTTPS/browser guidance before prompting", async () => {
    const transport = new WebSerialArduinoTransport({
      environment: { secureContext: false, userAgent: "Chrome" },
    });

    await expect(transport.connect()).rejects.toMatchObject({
      code: "not-secure-context",
      message: expect.stringContaining("HTTPS"),
    });
    expect(transport.phase).toBe("error");
  });
});

describe("WebSerialArduinoTransport upload lifecycle", () => {
  it("validates, programs, verifies, and keeps the port until explicit disconnect", async () => {
    const port = new MockSerialPort({ fragmentResponses: true });
    const transport = transportFor(port);
    const phases: HardwareWorkflowPhase[] = [];
    transport.subscribe((phase) => phases.push(phase));
    await transport.connect();
    const progress = vi.fn();

    await expect(transport.upload(artifact(), progress)).resolves.toEqual({
      bytesWritten: 4,
      completedAt: "2026-08-07T12:34:56.000Z",
    });

    expect(transport.phase).toBe("success");
    expect(port.opened).toBe(true);
    expect(port.closeCount).toBe(0);
    expect(progress).toHaveBeenLastCalledWith({
      phase: "verifying",
      bytesWritten: 4,
      totalBytes: 4,
    });
    expect(phases).toEqual(["connecting", "connected", "uploading", "success"]);

    await transport.disconnect();
    expect(port.closeCount).toBe(1);
    expect(port.closeWhileLocked).toBe(false);
  });

  it("closes the port and enters error when artifact validation or verification fails", async () => {
    const invalidPort = new MockSerialPort();
    const invalidTransport = transportFor(invalidPort);
    await invalidTransport.connect();

    await expect(
      invalidTransport.upload(artifact({ artifactHash: "c".repeat(64) }), vi.fn()),
    ).rejects.toMatchObject({ code: "artifact-invalid" });
    expect(invalidPort.closeCount).toBe(1);
    expect(invalidTransport.phase).toBe("error");

    const corruptPort = new MockSerialPort({ corruptVerification: true });
    const corruptTransport = transportFor(corruptPort);
    await corruptTransport.connect();
    await expect(corruptTransport.upload(artifact(), vi.fn())).rejects.toMatchObject({
      code: "upload-failed",
    });
    expect(corruptPort.readableMock.released).toBe(true);
    expect(corruptPort.writableMock.released).toBe(true);
    expect(corruptPort.closeWhileLocked).toBe(false);
    expect(corruptPort.closeCount).toBe(1);
    expect(corruptTransport.phase).toBe("error");
  });

  it("cancels a pending protocol read, unlocks streams, and closes the port", async () => {
    const port = new MockSerialPort({ ignoreCommand: 0x30 });
    const transport = new WebSerialArduinoTransport({
      environment: supportedEnvironment(port),
      digestHex: async () => ARTIFACT_HASH,
      uploaderOptions: {
        sleep: immediateSleep,
        syncTimeoutMs: 10_000,
      },
    });
    await transport.connect();
    const upload = transport.upload(artifact(), vi.fn());
    const rejection = expect(upload).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(port.commands).toHaveLength(1);
    });

    await transport.cancel();

    await rejection;
    expect(transport.phase).toBe("idle");
    expect(port.readableMock.released).toBe(true);
    expect(port.writableMock.released).toBe(true);
    expect(port.closeWhileLocked).toBe(false);
    expect(port.closeCount).toBe(1);
  });

  it("handles physical removal both while connected and during upload", async () => {
    const connectedPort = new MockSerialPort();
    const connectedTransport = transportFor(connectedPort);
    await connectedTransport.connect();

    connectedPort.physicallyDisconnect();

    expect(connectedTransport.phase).toBe("error");
    await vi.waitFor(() => {
      expect(connectedPort.closeCount).toBe(1);
    });
    await expect(connectedTransport.upload(artifact(), vi.fn())).rejects.toMatchObject({
      code: "device-not-connected",
    });

    const uploadingPort = new MockSerialPort({ ignoreCommand: 0x30 });
    const uploadingTransport = new WebSerialArduinoTransport({
      environment: supportedEnvironment(uploadingPort),
      digestHex: async () => ARTIFACT_HASH,
      uploaderOptions: { sleep: immediateSleep, syncTimeoutMs: 10_000 },
    });
    await uploadingTransport.connect();
    const upload = uploadingTransport.upload(artifact(), vi.fn());
    const rejection = expect(upload).rejects.toMatchObject({
      code: "device-disconnected",
    });
    await vi.waitFor(() => {
      expect(uploadingPort.commands).toHaveLength(1);
    });

    uploadingPort.physicallyDisconnect();

    await rejection;
    expect(uploadingTransport.phase).toBe("error");
    expect(uploadingPort.readableMock.released).toBe(true);
    expect(uploadingPort.writableMock.released).toBe(true);
    expect(uploadingPort.closeWhileLocked).toBe(false);
    expect(uploadingPort.closeCount).toBe(1);
  });

  it("can reconnect the same browser port object after physical removal", async () => {
    const port = new MockSerialPort();
    const uploader = vi.fn(async (_port, image: Uint8Array) => ({
      bytesWritten: image.length,
    }));
    const transport = new WebSerialArduinoTransport({
      environment: supportedEnvironment(port),
      digestHex: async () => ARTIFACT_HASH,
      uploader,
    });
    transport.subscribe(() => {
      throw new Error("A broken view listener must be isolated.");
    });
    await transport.connect();
    port.physicallyDisconnect();
    await vi.waitFor(() => {
      expect(port.closeCount).toBe(1);
    });

    await transport.connect();
    await expect(transport.upload(artifact(), vi.fn())).resolves.toMatchObject({
      bytesWritten: 4,
    });

    expect(transport.phase).toBe("success");
    expect(uploader).toHaveBeenCalledOnce();
    await transport.disconnect();
  });

  it("surfaces a close failure and clears the stale connection", async () => {
    const port = new MockSerialPort({ closeError: new Error("driver close failure") });
    const transport = transportFor(port);
    await transport.connect();

    await expect(transport.disconnect()).rejects.toMatchObject({
      code: "port-close-failed" satisfies HardwareTransportError["code"],
    });
    expect(transport.phase).toBe("error");
    await expect(transport.upload(artifact(), vi.fn())).rejects.toMatchObject({
      code: "device-not-connected",
    });
  });
});
