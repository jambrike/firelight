import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildWorkflowRunsUrl,
  parseStagingEvidence,
  parseStagingEvidenceEnvironment,
  verifyStagingEvidence,
} from "./verify-staging-evidence.mjs";

/* global AbortSignal, Response */

const SHA = "b".repeat(40);
const TOKEN = "github-token-that-must-remain-private";
const environment = {
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_REPOSITORY: "firelight-ie/firelight",
  GITHUB_SHA: SHA,
  GITHUB_TOKEN: TOKEN,
};

function assertCanaryCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function successfulRun(overrides = {}) {
  return {
    id: 123456789,
    run_number: 42,
    run_attempt: 1,
    head_sha: SHA,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/deploy-staging.yml@main",
    ...overrides,
  };
}

test("parseStagingEvidenceEnvironment accepts GitHub and GitHub Enterprise API bases", () => {
  assert.deepEqual(parseStagingEvidenceEnvironment(environment), {
    apiUrl: "https://api.github.com",
    owner: "firelight-ie",
    repository: "firelight",
    sha: SHA,
    token: TOKEN,
  });
  assert.equal(
    parseStagingEvidenceEnvironment({
      ...environment,
      GITHUB_API_URL: "https://github.example.test/api/v3",
    }).apiUrl,
    "https://github.example.test/api/v3",
  );
  assert.throws(
    () => parseStagingEvidenceEnvironment({
      ...environment,
      GITHUB_API_URL: "http://api.github.com",
    }),
    assertCanaryCode("INVALID_GITHUB_API_URL"),
  );
  assert.throws(
    () => parseStagingEvidenceEnvironment({
      ...environment,
      GITHUB_REPOSITORY: "firelight-ie/firelight/extra",
    }),
    assertCanaryCode("INVALID_GITHUB_REPOSITORY"),
  );
  assert.throws(
    () => parseStagingEvidenceEnvironment({ ...environment, GITHUB_SHA: "B".repeat(40) }),
    assertCanaryCode("INVALID_GITHUB_SHA"),
  );
});

test("workflow URL requests exact successful main push evidence by SHA", () => {
  const configuration = parseStagingEvidenceEnvironment(environment);
  const url = new URL(buildWorkflowRunsUrl(configuration));
  assert.equal(
    url.pathname,
    "/repos/firelight-ie/firelight/actions/workflows/deploy-staging.yml/runs",
  );
  assert.equal(url.searchParams.get("branch"), "main");
  assert.equal(url.searchParams.get("event"), "push");
  assert.equal(url.searchParams.get("status"), "success");
  assert.equal(url.searchParams.get("head_sha"), SHA);
  assert.equal(url.searchParams.get("per_page"), "10");
  assert.equal(url.href.includes(TOKEN), false);
});

test("parseStagingEvidence requires the exact SHA and completed staging workflow", () => {
  assert.deepEqual(
    parseStagingEvidence({ total_count: 1, workflow_runs: [successfulRun()] }, SHA),
    {
      runId: 123456789,
      runNumber: 42,
      runAttempt: 1,
      headSha: SHA,
    },
  );

  for (const overrides of [
    { head_sha: "c".repeat(40) },
    { head_branch: "feature" },
    { event: "workflow_dispatch" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { path: ".github/workflows/ci.yml" },
  ]) {
    assert.throws(
      () => parseStagingEvidence({
        total_count: 1,
        workflow_runs: [successfulRun(overrides)],
      }, SHA),
      assertCanaryCode("STAGING_EVIDENCE_NOT_FOUND"),
    );
  }
});

test("parseStagingEvidence rejects unbounded or malformed API lists", () => {
  assert.throws(
    () => parseStagingEvidence({ total_count: 1, workflow_runs: {} }, SHA),
    assertCanaryCode("INVALID_GITHUB_RESPONSE"),
  );
  assert.throws(
    () => parseStagingEvidence({
      total_count: 11,
      workflow_runs: Array.from({ length: 11 }, () => successfulRun()),
    }, SHA),
    assertCanaryCode("INVALID_GITHUB_RESPONSE"),
  );
});

test("verifyStagingEvidence sends a bounded authenticated API request", async () => {
  const configuration = parseStagingEvidenceEnvironment(environment);
  let requests = 0;
  const fetchImpl = async (input, init) => {
    requests += 1;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("head_sha"), SHA);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, "application/vnd.github+json");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify({
      total_count: 1,
      workflow_runs: [successfulRun()],
    }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.deepEqual(await verifyStagingEvidence(configuration, fetchImpl), {
    runId: 123456789,
    runNumber: 42,
    runAttempt: 1,
    headSha: SHA,
  });
  assert.equal(requests, 1);
});

test("verifyStagingEvidence maps API failures without exposing response details or token", async () => {
  const configuration = parseStagingEvidenceEnvironment(environment);
  const fetchImpl = async () => new Response(JSON.stringify({
    message: `credential ${TOKEN} rejected`,
  }), { status: 403 });

  await assert.rejects(
    verifyStagingEvidence(configuration, fetchImpl),
    assertCanaryCode("GITHUB_AUTH_FAILED"),
  );
});
