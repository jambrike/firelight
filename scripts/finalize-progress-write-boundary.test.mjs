import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  FINALIZE_PROGRESS_WRITE_BOUNDARY_QUERY,
  FINAL_PROGRESS_WRITE_BOUNDARY,
  buildProgressWriteBoundaryQueryUrl,
  finalizeProgressWriteBoundary,
  parseProgressWriteBoundaryEnvironment,
  parseProgressWriteBoundaryResult,
} from "./finalize-progress-write-boundary.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const TOKEN = "supabase-token-that-must-stay-private";
const environment = {
  SUPABASE_PROJECT_REF: PROJECT_REF,
  SUPABASE_ACCESS_TOKEN: TOKEN,
};

function resultBody(overrides = {}) {
  return [{ boundary: { ...FINAL_PROGRESS_WRITE_BOUNDARY, ...overrides } }];
}

function jsonResponse(body, status = 201, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

test("finalizer environment accepts only a canonical project ref and private token", () => {
  assert.deepEqual(parseProgressWriteBoundaryEnvironment(environment), {
    projectRef: PROJECT_REF,
    accessToken: TOKEN,
  });

  for (const invalid of [
    { ...environment, SUPABASE_PROJECT_REF: `${PROJECT_REF.slice(0, 19)}!` },
    { ...environment, SUPABASE_PROJECT_REF: PROJECT_REF.toUpperCase() },
    { ...environment, SUPABASE_ACCESS_TOKEN: "too-short" },
    { ...environment, SUPABASE_ACCESS_TOKEN: `${TOKEN}\n` },
  ]) {
    assert.throws(
      () => parseProgressWriteBoundaryEnvironment(invalid),
      (error) => {
        assert.ok(error instanceof CanaryError);
        assert.match(
          error.code,
          /^INVALID_SUPABASE_(?:PROJECT_REF|ACCESS_TOKEN)$/u,
        );
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      },
    );
  }
});

test("finalizer uses the exact bounded Management API mutation", async () => {
  const configuration = parseProgressWriteBoundaryEnvironment(environment);
  assert.equal(
    buildProgressWriteBoundaryQueryUrl(configuration),
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  );

  const result = await finalizeProgressWriteBoundary(
    configuration,
    async (input, init) => {
      assert.equal(String(input), buildProgressWriteBoundaryQueryUrl(configuration));
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.signal.aborted, false);
      assert.deepEqual(init.headers, {
        Accept: "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "firelight-progress-write-boundary-finalizer",
      });
      assert.equal(
        init.body,
        JSON.stringify({
          query: FINALIZE_PROGRESS_WRITE_BOUNDARY_QUERY,
          read_only: false,
        }),
      );
      return jsonResponse(resultBody());
    },
  );

  assert.deepEqual(result, FINAL_PROGRESS_WRITE_BOUNDARY);
});

test("finalizer accepts only the exact canonical database result", () => {
  assert.deepEqual(
    parseProgressWriteBoundaryResult(resultBody()),
    FINAL_PROGRESS_WRITE_BOUNDARY,
  );

  for (const invalid of [
    [],
    [resultBody()[0], resultBody()[0]],
    { boundary: FINAL_PROGRESS_WRITE_BOUNDARY },
    [{ boundary: FINAL_PROGRESS_WRITE_BOUNDARY, extra: true }],
    [{ boundary: { ...FINAL_PROGRESS_WRITE_BOUNDARY, extra: true } }],
    resultBody({ authenticated_update: true }),
    resultBody({ mutation_policy_count: "0" }),
  ]) {
    assert.throws(
      () => parseProgressWriteBoundaryResult(invalid),
      assertCode("INVALID_PROGRESS_WRITE_BOUNDARY_RESULT"),
    );
  }
});

test("Management API failures expose only stable safe error codes", async () => {
  const configuration = parseProgressWriteBoundaryEnvironment(environment);
  for (const [status, expectedCode] of [
    [401, "SUPABASE_MANAGEMENT_AUTH_FAILED"],
    [403, "SUPABASE_MANAGEMENT_AUTH_FAILED"],
    [404, "SUPABASE_PROJECT_NOT_FOUND"],
    [429, "SUPABASE_MANAGEMENT_RATE_LIMITED"],
    [500, "SUPABASE_PROGRESS_WRITE_BOUNDARY_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      finalizeProgressWriteBoundary(
        configuration,
        async () => jsonResponse({ secret: TOKEN }, status),
      ),
      assertCode(expectedCode),
    );
  }
});

test("successful responses require status 201, JSON, and a bounded body", async () => {
  const configuration = parseProgressWriteBoundaryEnvironment(environment);

  await assert.rejects(
    finalizeProgressWriteBoundary(
      configuration,
      async () => jsonResponse(resultBody(), 200),
    ),
    assertCode("SUPABASE_PROGRESS_WRITE_BOUNDARY_UNAVAILABLE"),
  );
  await assert.rejects(
    finalizeProgressWriteBoundary(
      configuration,
      async () => new Response(JSON.stringify(resultBody()), {
        status: 201,
        headers: { "Content-Type": "text/plain" },
      }),
    ),
    assertCode("INVALID_PROGRESS_WRITE_BOUNDARY_RESPONSE"),
  );
  await assert.rejects(
    finalizeProgressWriteBoundary(
      configuration,
      async () => new Response("{}", {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(32 * 1024 + 1),
        },
      }),
    ),
    assertCode("RESPONSE_TOO_LARGE"),
  );
});
