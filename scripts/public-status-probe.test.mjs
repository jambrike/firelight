import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import {
  PUBLIC_PROBE_RESPONSE_BYTES,
  PUBLIC_PROBE_RETRY_DELAY_MS,
  PUBLIC_PROBE_TIMEOUT_MS,
  PublicProbeError,
  parsePublicProbeEnvironment,
  probeStatusEndpoint,
  readBoundedProbeResponse,
  runPublicStatusProbe,
  safePublicProbeErrorCode,
  validatePublicStatusEnvelope,
} from "./public-status-probe.mjs";

/* global AbortSignal, DOMException, ReadableStream, Response */

const BUILD_ID = "a".repeat(40);
const STAGING = Object.freeze({
  FIRELIGHT_BASE_URL: "https://staging.firelight.ie",
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
});

function statusBody(status, overrides = {}) {
  return {
    data: {
      status,
      environment: "staging",
      buildId: BUILD_ID,
      ...overrides,
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function assertProbeCode(expected) {
  return (error) => {
    assert.ok(error instanceof PublicProbeError);
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    return true;
  };
}

test("probe configuration accepts only canonical environment/host pairs", () => {
  assert.deepEqual(parsePublicProbeEnvironment(STAGING), {
    baseUrl: "https://staging.firelight.ie",
    expectedEnvironment: "staging",
  });
  assert.deepEqual(
    parsePublicProbeEnvironment({
      FIRELIGHT_BASE_URL: "https://firelight.ie",
      FIRELIGHT_EXPECTED_ENVIRONMENT: "production",
    }),
    { baseUrl: "https://firelight.ie", expectedEnvironment: "production" },
  );

  for (const invalid of [
    { ...STAGING, FIRELIGHT_BASE_URL: "https://staging.firelight.ie/" },
    { ...STAGING, FIRELIGHT_BASE_URL: "https://firelight.ie" },
    { ...STAGING, FIRELIGHT_EXPECTED_ENVIRONMENT: "preview" },
    { ...STAGING, FIRELIGHT_EXPECTED_ENVIRONMENT: "staging\n" },
  ]) {
    assert.throws(() => parsePublicProbeEnvironment(invalid), PublicProbeError);
  }
});

test("strict status envelopes bind status, environment, and commit-shaped build", () => {
  assert.equal(
    validatePublicStatusEnvelope(statusBody("ok"), {
      expectedEnvironment: "staging",
      expectedStatus: "ok",
    }),
    BUILD_ID,
  );

  assert.throws(
    () => validatePublicStatusEnvelope(
      { ...statusBody("ok"), metadata: {} },
      { expectedEnvironment: "staging", expectedStatus: "ok" },
    ),
    assertProbeCode("INVALID_STATUS_ENVELOPE"),
  );
  for (const body of [
    statusBody("ready"),
    statusBody("ok", { environment: "production" }),
    statusBody("ok", { buildId: "staging" }),
    statusBody("ok", { extra: true }),
  ]) {
    assert.throws(
      () => validatePublicStatusEnvelope(body, {
        expectedEnvironment: "staging",
        expectedStatus: "ok",
      }),
      PublicProbeError,
    );
  }
});

test("endpoint probing is bounded, non-redirecting, and JSON-only", async () => {
  let observed;
  const build = await probeStatusEndpoint(
    async (url, init) => {
      observed = { url, init };
      return jsonResponse(statusBody("ok"));
    },
    "https://staging.firelight.ie/api/health",
    { expectedEnvironment: "staging", expectedStatus: "ok" },
  );
  assert.equal(build, BUILD_ID);
  assert.equal(observed.url, "https://staging.firelight.ie/api/health");
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.headers.Accept, "application/json");
  assert.ok(observed.init.signal instanceof AbortSignal);

  for (const contentType of ["text/plain", "application/jsonp"]) {
    await assert.rejects(
      probeStatusEndpoint(
        async () => new Response(JSON.stringify(statusBody("ok")), {
          headers: { "Content-Type": contentType },
        }),
        "https://staging.firelight.ie/api/health",
        { expectedEnvironment: "staging", expectedStatus: "ok" },
      ),
      assertProbeCode("STATUS_REQUEST_FAILED"),
    );
  }
});

test("response reading rejects declared and streamed overflow", async () => {
  await assert.rejects(
    readBoundedProbeResponse(
      new Response("{}", {
        headers: { "Content-Length": String(PUBLIC_PROBE_RESPONSE_BYTES + 1) },
      }),
    ),
    assertProbeCode("RESPONSE_TOO_LARGE"),
  );

  const chunk = new Uint8Array(PUBLIC_PROBE_RESPONSE_BYTES);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedProbeResponse(new Response(stream)),
    assertProbeCode("RESPONSE_TOO_LARGE"),
  );
});

test("the fixed deadline aborts a stalled request", async () => {
  const stalledFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
  await assert.rejects(
    probeStatusEndpoint(
      stalledFetch,
      "https://staging.firelight.ie/api/health",
      { expectedEnvironment: "staging", expectedStatus: "ok" },
      { timeoutMs: 1 },
    ),
    assertProbeCode("REQUEST_TIMEOUT"),
  );
});

test("the recurring probe retries the complete pair once and can recover", async () => {
  const configuration = parsePublicProbeEnvironment(STAGING);
  let requests = 0;
  const delays = [];
  const fetchImpl = async (input) => {
    requests += 1;
    if (requests <= 2) throw new Error("first attempt unavailable");
    const path = new URL(input).pathname;
    return jsonResponse(statusBody(path.endsWith("health") ? "ok" : "ready"));
  };
  const result = await runPublicStatusProbe(configuration, {
    fetchImpl,
    waitImpl: async (milliseconds) => { delays.push(milliseconds); },
  });

  assert.equal(result, BUILD_ID);
  assert.equal(requests, 4);
  assert.deepEqual(delays, [PUBLIC_PROBE_RETRY_DELAY_MS]);
});

test("the recurring probe fails after two bad pairs and rejects split builds", async () => {
  const configuration = parsePublicProbeEnvironment(STAGING);
  let requests = 0;
  await assert.rejects(
    runPublicStatusProbe(configuration, {
      fetchImpl: async () => {
        requests += 1;
        throw new Error("private transport detail that must not escape");
      },
      waitImpl: async () => undefined,
    }),
    assertProbeCode("NETWORK_REQUEST_FAILED"),
  );
  assert.equal(requests, 4);

  await assert.rejects(
    runPublicStatusProbe(configuration, {
      fetchImpl: async (input) => {
        const path = new URL(input).pathname;
        return jsonResponse(
          statusBody(path.endsWith("health") ? "ok" : "ready", {
            buildId: path.endsWith("health") ? BUILD_ID : "b".repeat(40),
          }),
        );
      },
      waitImpl: async () => undefined,
    }),
    assertProbeCode("STATUS_BUILD_MISMATCH"),
  );
});

test("probe constants and unknown-error rendering remain bounded", () => {
  assert.equal(PUBLIC_PROBE_TIMEOUT_MS, 10_000);
  assert.equal(PUBLIC_PROBE_RESPONSE_BYTES, 16 * 1024);
  assert.equal(safePublicProbeErrorCode(new Error("secret detail")), "PUBLIC_PROBE_FAILED");
});
