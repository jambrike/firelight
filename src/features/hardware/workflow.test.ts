import { describe, expect, it, vi } from "vitest";
import type { UploadEvidence } from "../../../shared/hardware";
import type {
  ArduinoTransport,
  CompileArtifact,
  CompileRequest,
  HardwareWorkflowPhase,
} from "./contracts";
import { FIRELIGHT_BOARD_FQBN } from "./contracts";
import type { UploadEvidenceRecorder } from "./compiler-client";
import {
  HardwareWorkflowController,
  type HardwareWorkflowDependencies,
} from "./workflow";

const SOURCE_HASH = "e16477fe0db639568e97cec3d11f8bb5bd41d91413582c8fbb2e36df4a5f1c2a";

const artifact: CompileArtifact = {
  compileJobId: "33333333-3333-4333-8333-333333333333",
  format: "intel-hex",
  fqbn: FIRELIGHT_BOARD_FQBN,
  sourceHash: SOURCE_HASH,
  artifactHash: "b".repeat(64),
  hex: ":00000001FF\n",
  diagnostics: [],
};
const request: CompileRequest = {
  lessonId: "first-spark",
  lessonVersion: 1,
  fqbn: FIRELIGHT_BOARD_FQBN,
  source: "void setup() {}\nvoid loop() {}\n",
};
const evidence: UploadEvidence = {
  id: "44444444-4444-4444-8444-444444444444",
  compileJobId: artifact.compileJobId,
  lessonId: "first-spark",
  lessonVersion: 1,
  sourceHash: artifact.sourceHash,
  artifactHash: artifact.artifactHash,
  bytesWritten: 128,
  recordedAt: "2026-08-07T12:00:00.000Z",
  attestation: "browser-web-serial-v1",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(overrides: {
  readonly record?: UploadEvidenceRecorder["record"];
  readonly compile?: HardwareWorkflowDependencies["compiler"]["compile"];
  readonly readSerial?: ArduinoTransport["readSerial"];
  readonly disconnect?: ArduinoTransport["disconnect"];
} = {}) {
  const listeners = new Set<(phase: HardwareWorkflowPhase) => void>();
  let transportPhase: HardwareWorkflowPhase = "idle";
  const transport: ArduinoTransport = {
    get phase() {
      return transportPhase;
    },
    detectCapability: () => ({ supported: true }),
    connect: vi.fn(async () => {
      transportPhase = "connected";
      listeners.forEach((listener) => {
        listener("connected");
      });
      return { displayName: "Test Nano", usbVendorId: 0x2341, usbProductId: 0x0043 };
    }),
    disconnect: vi.fn(overrides.disconnect ?? (async () => {
        transportPhase = "idle";
        listeners.forEach((listener) => {
          listener("idle");
        });
      })),
    cancel: vi.fn(async () => {
      transportPhase = "idle";
      listeners.forEach((listener) => {
        listener("idle");
      });
    }),
    validateArtifact: vi.fn(async () => undefined),
    upload: vi.fn(async (_artifact, onProgress) => {
      transportPhase = "uploading";
      onProgress({ phase: "writing", bytesWritten: 64, totalBytes: 128 });
      transportPhase = "success";
      listeners.forEach((listener) => {
        listener("success");
      });
      return { bytesWritten: 128, completedAt: "2026-08-07T12:00:00.000Z" };
    }),
    readSerial: vi.fn(overrides.readSerial ?? (async (options, onData) => {
        onData("128\n");
        return {
          baudRate: options.baudRate,
          text: "128\n",
          bytesRead: 4,
          truncated: false,
        };
      })),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const compiler = {
    compile: vi.fn(overrides.compile ?? (async () => artifact)),
  };
  const evidenceRecorder: UploadEvidenceRecorder = {
    record: vi.fn(overrides.record ?? (async () => evidence)),
  };
  const controller = new HardwareWorkflowController({
    compiler,
    transport,
    evidenceRecorder,
  });
  return {
    controller,
    compiler,
    transport,
    evidenceRecorder,
    disconnectPhysically() {
      transportPhase = "error";
      listeners.forEach((listener) => {
        listener("error");
      });
    },
  };
}

describe("HardwareWorkflowController", () => {
  it("runs the explicit compile, connect, upload, evidence-success sequence", async () => {
    const { controller, transport, evidenceRecorder } = setup();
    const phases: HardwareWorkflowPhase[] = [];
    controller.subscribe(() => phases.push(controller.getSnapshot().phase));

    await controller.compile(request);
    expect(controller.getSnapshot().phase).toBe("compiled");
    await controller.connect();
    expect(controller.getSnapshot().device?.displayName).toBe("Test Nano");
    await controller.upload();

    expect(phases).toEqual([
      "compiling",
      "compiled",
      "connecting",
      "connected",
      "uploading",
      "uploading",
      "success",
    ]);
    expect(transport.validateArtifact).toHaveBeenCalledWith(artifact);
    expect(evidenceRecorder.record).toHaveBeenCalledWith(
      artifact,
      expect.objectContaining({ bytesWritten: 128 }),
      expect.any(AbortSignal),
    );
    expect(controller.getSnapshot().evidence).toEqual(evidence);
  });

  it("invalidates a stale compiled artifact and its completion evidence on code edits", async () => {
    const { controller } = setup();
    await controller.compile(request);
    await controller.connect();
    await controller.upload();
    expect(controller.getSnapshot().phase).toBe("success");

    await controller.invalidateCode();

    expect(controller.getSnapshot()).toMatchObject({
      phase: "connected",
      artifact: null,
      evidence: null,
      progress: null,
      error: null,
    });
  });

  it("does not report success when server evidence mismatches the uploaded artifact", async () => {
    const { controller } = setup({
      record: async () => ({ ...evidence, artifactHash: "c".repeat(64) }),
    });
    await controller.compile(request);
    await controller.connect();

    await expect(controller.upload()).rejects.toThrow("did not match");
    expect(controller.getSnapshot().phase).toBe("error");
    expect(controller.getSnapshot().evidence).toBeNull();
  });

  it("preserves recorded evidence across an unsolicited physical disconnect", async () => {
    const { controller, disconnectPhysically } = setup();
    await controller.compile(request);
    await controller.connect();
    await controller.upload();

    disconnectPhysically();

    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      device: null,
      evidence,
      error: "The board disconnected. Reconnect it before uploading again.",
    });
  });

  it("opens a bounded 9600-baud serial capture only after upload evidence", async () => {
    const { controller, transport } = setup();
    await controller.compile(request);
    await controller.connect();
    await expect(controller.readSerial(9_600)).rejects.toThrow("Upload");
    await controller.upload();

    await expect(controller.readSerial(9_600)).resolves.toEqual({
      baudRate: 9_600,
      text: "128\n",
      bytesRead: 4,
      truncated: false,
    });

    expect(transport.readSerial).toHaveBeenCalledWith(
      { baudRate: 9_600 },
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(controller.getSnapshot()).toMatchObject({
      phase: "success",
      evidence,
      serial: { text: "128\n", baudRate: 9_600 },
      serialReading: false,
    });
  });

  it("binds compilation to the exact submitted source hash", async () => {
    const { controller, transport } = setup({
      compile: async () => ({ ...artifact, sourceHash: "a".repeat(64) }),
    });

    await expect(controller.compile(request)).rejects.toThrow("current sketch");
    expect(transport.validateArtifact).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      artifact: null,
      evidence: null,
    });
  });

  it("makes connect idempotent once the selected device is attached", async () => {
    const { controller, transport } = setup();
    await controller.compile(request);

    const first = await controller.connect();
    const second = await controller.connect();

    expect(second).toEqual(first);
    expect(transport.connect).toHaveBeenCalledOnce();
  });

  it("keeps prior evidence when a repeat upload or disconnect fails", async () => {
    let recordCount = 0;
    const { controller } = setup({
      record: async () => {
        recordCount += 1;
        return recordCount === 1
          ? evidence
          : { ...evidence, recordedAt: "not-a-timestamp" };
      },
    });
    await controller.compile(request);
    await controller.connect();
    await controller.upload();

    await expect(controller.upload()).rejects.toThrow("did not match");
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", evidence });

    await controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "success",
      device: null,
      evidence,
    });
  });

  it("rejects malformed evidence metadata instead of trusting typed JSON", async () => {
    const { controller } = setup({
      record: async () => ({
        ...evidence,
        bytesWritten: Number.NaN,
        recordedAt: "2026-02-30T12:00:00Z",
      }),
    });
    await controller.compile(request);
    await controller.connect();

    await expect(controller.upload()).rejects.toThrow("did not match");
    expect(controller.getSnapshot().evidence).toBeNull();
  });

  it("clears workflow listeners in finally when dispose cleanup rejects", async () => {
    const { controller, disconnectPhysically } = setup({
      disconnect: async () => {
        throw new Error("close failed");
      },
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    await expect(controller.dispose()).rejects.toThrow("close failed");
    listener.mockClear();
    disconnectPhysically();
    expect(listener).not.toHaveBeenCalled();
  });

  it("prevents a stale evidence response from mutating a replacement compile", async () => {
    const pendingEvidence = deferred<UploadEvidence>();
    const pendingReplacement = deferred<CompileArtifact>();
    let compileCount = 0;
    const { controller } = setup({
      compile: async () => {
        compileCount += 1;
        return compileCount === 1 ? artifact : pendingReplacement.promise;
      },
      // Deliberately ignore the signal to prove the controller also guards stale results.
      record: async () => pendingEvidence.promise,
    });
    await controller.compile(request);
    await controller.connect();
    const staleUpload = controller.upload();
    await vi.waitFor(() => {
      expect(controller.getSnapshot().phase).toBe("uploading");
    });

    await controller.cancel();
    const replacementCompile = controller.compile(request);
    expect(controller.getSnapshot().phase).toBe("compiling");

    pendingEvidence.resolve(evidence);
    await expect(staleUpload).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.getSnapshot().phase).toBe("compiling");

    pendingReplacement.resolve(artifact);
    await expect(replacementCompile).resolves.toEqual(artifact);
    expect(controller.getSnapshot().phase).toBe("compiled");
  });
});
