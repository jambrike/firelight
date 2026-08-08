import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildReleaseRunsUrl,
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
    head_branch: "v1.2.3",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/deploy-production.yml@main",
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
});

test("release-run URL is pinned to the workflow and exact build", () => {
  const url = new URL(buildReleaseRunsUrl(
    parseReleaseRunEnvironment(baseEnvironment),
  ));
  assert.equal(
    url.pathname,
    "/repos/firelight-ie/firelight/actions/workflows/deploy-production.yml/runs",
  );
  assert.equal(url.searchParams.get("status"), "success");
  assert.equal(url.searchParams.get("head_sha"), SHA);
  assert.equal(url.searchParams.get("per_page"), "10");
  assert.equal(url.href.includes(TOKEN), false);
});

test("production evidence requires an exact successful release workflow run", () => {
  const configuration = parseReleaseRunEnvironment(baseEnvironment);
  assert.deepEqual(parseReleaseRun({
    total_count: 1,
    workflow_runs: [productionRun()],
  }, configuration), { runId: 123456789, headSha: SHA });
  assert.deepEqual(parseReleaseRun({
    total_count: 1,
    workflow_runs: [productionRun({ event: "workflow_dispatch" })],
  }, configuration), { runId: 123456789, headSha: SHA });
  for (const overrides of [
    { head_sha: "c".repeat(40) },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { path: ".github/workflows/rollback-worker.yml" },
  ]) {
    assert.throws(
      () => parseReleaseRun({
        total_count: 1,
        workflow_runs: [productionRun(overrides)],
      }, configuration),
      assertCode("ACCEPTED_RELEASE_RUN_NOT_FOUND"),
    );
  }
});

test("staging evidence additionally requires main", () => {
  const configuration = parseReleaseRunEnvironment({
    ...baseEnvironment,
    FIRELIGHT_RELEASE_ENVIRONMENT: "staging",
  });
  const stagingRun = productionRun({
    head_branch: "main",
    path: ".github/workflows/deploy-staging.yml@main",
  });
  assert.equal(parseReleaseRun({
    total_count: 1,
    workflow_runs: [stagingRun],
  }, configuration).runId, 123456789);
  assert.throws(
    () => parseReleaseRun({
      total_count: 1,
      workflow_runs: [productionRun({
        path: ".github/workflows/deploy-staging.yml@main",
      })],
    }, configuration),
    assertCode("ACCEPTED_RELEASE_RUN_NOT_FOUND"),
  );
});

test("release-run request is bounded, authenticated, and safely failed", async () => {
  const configuration = parseReleaseRunEnvironment(baseEnvironment);
  const result = await verifyReleaseRun(configuration, async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get("head_sha"), SHA);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify({
      total_count: 1,
      workflow_runs: [productionRun()],
    }));
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
