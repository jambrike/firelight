import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_PROPAGATION_ATTEMPTS,
  RELEASE_PROPAGATION_DELAY_MS,
  parseReleasePropagationEnvironment,
  waitForExpectedRelease,
} from "./wait-for-release.mjs";

/* global Response */

const EXPECTED_BUILD = "a".repeat(40);
const PREVIOUS_BUILD = "b".repeat(40);
const ENVIRONMENT = Object.freeze({
  FIRELIGHT_BASE_URL: "https://staging.firelight.ie",
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
  FIRELIGHT_EXPECTED_BUILD_ID: EXPECTED_BUILD,
});

function statusResponse(status, buildId) {
  return new Response(JSON.stringify({
    data: { status, environment: "staging", buildId },
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

test("release propagation configuration pins the canonical host and exact commit", () => {
  assert.deepEqual(parseReleasePropagationEnvironment(ENVIRONMENT), {
    baseUrl: "https://staging.firelight.ie",
    expectedEnvironment: "staging",
    expectedBuildId: EXPECTED_BUILD,
  });
  for (const invalidBuild of [undefined, "staging", "A".repeat(40)]) {
    assert.throws(
      () => parseReleasePropagationEnvironment({
        ...ENVIRONMENT,
        FIRELIGHT_EXPECTED_BUILD_ID: invalidBuild,
      }),
      /INVALID_FIRELIGHT_EXPECTED_BUILD_ID/u,
    );
  }
});

test("the poll tolerates an old edge build and stops on the expected release", async () => {
  const configuration = parseReleasePropagationEnvironment(ENVIRONMENT);
  let requestCount = 0;
  const waits = [];
  const result = await waitForExpectedRelease(configuration, {
    fetchImpl: async (input) => {
      requestCount += 1;
      const status = String(input).endsWith("/api/health") ? "ok" : "ready";
      const attempt = Math.ceil(requestCount / 2);
      return statusResponse(status, attempt < 3 ? PREVIOUS_BUILD : EXPECTED_BUILD);
    },
    waitImpl: async (milliseconds) => waits.push(milliseconds),
    attempts: 4,
    delayMs: 7,
  });
  assert.equal(result, EXPECTED_BUILD);
  assert.equal(requestCount, 6);
  assert.deepEqual(waits, [7, 7]);
});

test("the poll is bounded and emits only a stable final failure", async () => {
  const configuration = parseReleasePropagationEnvironment(ENVIRONMENT);
  let requests = 0;
  await assert.rejects(
    waitForExpectedRelease(configuration, {
      fetchImpl: async () => {
        requests += 1;
        throw new Error("transport detail with private hostname");
      },
      waitImpl: async () => undefined,
      attempts: 3,
      delayMs: 0,
    }),
    (error) => {
      assert.equal(error.code, "NETWORK_REQUEST_FAILED");
      assert.equal(error.message.includes("private hostname"), false);
      return true;
    },
  );
  assert.equal(requests, 6);
});

test("release polling defaults remain bounded", () => {
  assert.equal(RELEASE_PROPAGATION_ATTEMPTS, 12);
  assert.equal(RELEASE_PROPAGATION_DELAY_MS, 10_000);
});
