import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildWorkerSettingsUrl,
  parseWorkerTargetEnvironment,
  verifyWorkerTarget,
} from "./verify-worker-target.mjs";

/* global AbortSignal, Response */

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "cloudflare-token-that-must-remain-private";
const baseEnvironment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
  FIRELIGHT_WORKER_ENVIRONMENT: "staging",
  FIRELIGHT_WORKER_TARGET_MODE: "bootstrap",
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("worker target configuration binds each environment to one exact Worker", () => {
  const staging = parseWorkerTargetEnvironment(baseEnvironment);
  assert.equal(staging.workerName, "firelight-staging");
  assert.equal(
    new URL(buildWorkerSettingsUrl(staging)).pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/firelight-staging/settings`,
  );
  assert.equal(parseWorkerTargetEnvironment({
    ...baseEnvironment,
    FIRELIGHT_WORKER_ENVIRONMENT: "production",
    FIRELIGHT_WORKER_TARGET_MODE: "existing",
  }).workerName, "firelight-production");
  assert.throws(
    () => parseWorkerTargetEnvironment({
      ...baseEnvironment,
      FIRELIGHT_WORKER_TARGET_MODE: "replace",
    }),
    assertCode("INVALID_FIRELIGHT_WORKER_TARGET_MODE"),
  );
});

test("bootstrap accepts only Cloudflare's exact missing-Worker response", async () => {
  const configuration = parseWorkerTargetEnvironment(baseEnvironment);
  let requests = 0;
  const result = await verifyWorkerTarget(configuration, async (input, init) => {
    requests += 1;
    assert.equal(String(input), buildWorkerSettingsUrl(configuration));
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return response({
      success: false,
      errors: [{ code: 10007, message: "Worker not found" }],
      messages: [],
      result: null,
    }, 404);
  });
  assert.deepEqual(result, {
    environment: "staging",
    workerName: "firelight-staging",
    targetMode: "bootstrap",
  });
  assert.equal(requests, 1);

  for (const invalidResponse of [
    response({ success: true, errors: [], messages: [], result: {} }),
    response({
      success: false,
      errors: [{ code: 10000, message: TOKEN }],
      messages: [],
    }, 404),
    response({
      success: false,
      errors: [{ code: 10007, message: "Worker not found" }],
      messages: [],
    }, 403),
  ]) {
    await assert.rejects(
      verifyWorkerTarget(configuration, async () => invalidResponse.clone()),
      (error) => {
        assert.ok(error instanceof CanaryError);
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      },
    );
  }
});

test("existing mode requires an exact successful settings envelope", async () => {
  const configuration = parseWorkerTargetEnvironment({
    ...baseEnvironment,
    FIRELIGHT_WORKER_TARGET_MODE: "existing",
  });
  assert.equal((await verifyWorkerTarget(configuration, async () => response({
    success: true,
    errors: [],
    messages: [],
    result: { compatibility_date: "2026-08-08" },
  }))).targetMode, "existing");
  await assert.rejects(
    verifyWorkerTarget(configuration, async () => response({
      success: false,
      errors: [{ code: 10007, message: "Worker not found" }],
      messages: [],
    }, 404)),
    assertCode("CLOUDFLARE_API_FAILED"),
  );
  await assert.rejects(
    verifyWorkerTarget(configuration, async () => response({
      success: true,
      errors: [],
      messages: [],
      result: null,
    })),
    assertCode("INVALID_CLOUDFLARE_RESPONSE"),
  );
});
