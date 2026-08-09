import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildReleaseRunUrl,
  parseReleaseRun,
  parseReleaseRunEnvironment,
  verifyReleaseRun,
} from "./verify-release-run.mjs";

/* global AbortSignal, Response */

const SHA = "b".repeat(40);
const TOKEN = "github-token-that-must-remain-private";
const baseEnvironment = {
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_REPOSITORY: "firelight-ie/firelight",
  GITHUB_TOKEN: TOKEN,
  FIRELIGHT_RELEASE_ENVIRONMENT: "production",
  FIRELIGHT_RELEASE_BUILD_ID: SHA,
  FIRELIGHT_RELEASE_RUN_ID: "123456789",
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function productionRun(overrides = {}) {
  return {
    id: 123456789,
    run_attempt: 1,
    head_sha: SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/deploy-production.yml@main",
    repository: { id: 1234, full_name: "firelight-ie/firelight" },
    ...overrides,
  };
}

test("release-run environment selects only controlled deploy workflows", () => {
  const configuration = parseReleaseRunEnvironment(baseEnvironment);
  assert.equal(configuration.release.workflow, "deploy-production.yml");
  assert.throws(
    () => parseReleaseRunEnvironment({
      ...baseEnvironment,
      FIRELIGHT_RELEASE_ENVIRONMENT: "preview",
    }),
    assertCode("INVALID_FIRELIGHT_RELEASE_ENVIRONMENT"),
  );
  assert.throws(
    () => parseReleaseRunEnvironment({
      ...baseEnvironment,
      FIRELIGHT_RELEASE_BUILD_ID: "B".repeat(40),
    }),
    assertCode("INVALID_FIRELIGHT_RELEASE_BUILD_ID"),
  );
  assert.throws(
    () => parseReleaseRunEnvironment({
      ...baseEnvironment,
      FIRELIGHT_RELEASE_RUN_ID: "0",
    }),
    assertCode("INVALID_FIRELIGHT_RELEASE_RUN_ID"),
  );
});

test("release-run URL is pinned to the exact accepted run", () => {
  const url = new URL(buildReleaseRunUrl(
    parseReleaseRunEnvironment(baseEnvironment),
  ));
  assert.equal(
    url.pathname,
    "/repos/firelight-ie/firelight/actions/runs/123456789",
  );
  assert.equal(url.search, "");
  assert.equal(url.href.includes(TOKEN), false);
});

test("production evidence requires an exact successful release workflow run", () => {
  const configuration = parseReleaseRunEnvironment(baseEnvironment);
  assert.deepEqual(parseReleaseRun(productionRun(), configuration), {
    runId: 123456789,
    headSha: SHA,
  });
  for (const overrides of [
    { id: 123456788 },
    { head_sha: "c".repeat(40) },
    { head_branch: "release-branch" },
    { event: "push" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { path: ".github/workflows/rollback-worker.yml" },
    {
      repository: {
        id: 9999,
        full_name: "other-owner/firelight",
      },
    },
  ]) {
    assert.throws(
      () => parseReleaseRun({
        ...productionRun(overrides),
      }, configuration),
      assertCode("ACCEPTED_RELEASE_RUN_NOT_FOUND"),
    );
  }
});

test("release evidence requires a manually dispatched main run", () => {
  const configuration = parseReleaseRunEnvironment({
    ...baseEnvironment,
    FIRELIGHT_RELEASE_ENVIRONMENT: "staging",
  });
  const stagingRun = productionRun({
    head_branch: "main",
    path: ".github/workflows/deploy-staging.yml@main",
  });
  assert.equal(parseReleaseRun(stagingRun, configuration).runId, 123456789);
  assert.throws(
    () => parseReleaseRun({
      ...productionRun({
        head_branch: "release-branch",
        path: ".github/workflows/deploy-staging.yml@main",
      }),
    }, configuration),
    assertCode("ACCEPTED_RELEASE_RUN_NOT_FOUND"),
  );
});

test("release-run request is bounded, authenticated, and safely failed", async () => {
  const configuration = parseReleaseRunEnvironment(baseEnvironment);
  const result = await verifyReleaseRun(configuration, async (input, init) => {
    assert.equal(
      new URL(String(input)).pathname,
      "/repos/firelight-ie/firelight/actions/runs/123456789",
    );
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify(productionRun()));
  });
  assert.equal(result.runId, 123456789);

  await assert.rejects(
    verifyReleaseRun(configuration, async () => new Response(
      JSON.stringify({ message: TOKEN }),
      { status: 403 },
    )),
    assertCode("GITHUB_AUTH_FAILED"),
  );
});
