import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const LOWERCASE_BUILD_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_PATH = ".github/workflows/deploy-staging.yml";
const WORKFLOW_PATH_ON_MAIN = `${WORKFLOW_PATH}@main`;

function fail(code) {
  throw new CanaryError(code);
}

function requiredString(environment, name, maximum) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    fail(`INVALID_${name}`);
  }
  return value;
}

function validRepositorySegment(value) {
  return REPOSITORY_SEGMENT.test(value) && value !== "." && value !== "..";
}

export function parseStagingEvidenceEnvironment(environment) {
  const rawApiUrl = requiredString(environment, "GITHUB_API_URL", 2048);
  let parsedApiUrl;
  try {
    parsedApiUrl = new URL(rawApiUrl);
  } catch {
    fail("INVALID_GITHUB_API_URL");
  }
  const normalizedPath = parsedApiUrl.pathname === "/"
    ? ""
    : parsedApiUrl.pathname.replace(/\/$/u, "");
  const normalizedApiUrl = `${parsedApiUrl.origin}${normalizedPath}`;
  if (
    parsedApiUrl.protocol !== "https:" ||
    parsedApiUrl.username !== "" ||
    parsedApiUrl.password !== "" ||
    parsedApiUrl.search !== "" ||
    parsedApiUrl.hash !== "" ||
    rawApiUrl !== normalizedApiUrl
  ) {
    fail("INVALID_GITHUB_API_URL");
  }

  const repository = requiredString(environment, "GITHUB_REPOSITORY", 201);
  const segments = repository.split("/");
  if (
    segments.length !== 2 ||
    !validRepositorySegment(segments[0] ?? "") ||
    !validRepositorySegment(segments[1] ?? "")
  ) {
    fail("INVALID_GITHUB_REPOSITORY");
  }

  const sha = requiredString(environment, "GITHUB_SHA", 40);
  if (!LOWERCASE_BUILD_SHA.test(sha)) fail("INVALID_GITHUB_SHA");

  const token = requiredString(environment, "GITHUB_TOKEN", 4096);
  if (/\s/u.test(token)) fail("INVALID_GITHUB_TOKEN");

  return {
    apiUrl: normalizedApiUrl,
    owner: segments[0],
    repository: segments[1],
    sha,
    token,
  };
}

export function buildWorkflowRunsUrl(configuration) {
  const url = new URL(
    `${configuration.apiUrl}/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repository)}/actions/workflows/deploy-staging.yml/runs`,
  );
  url.searchParams.set("branch", "main");
  url.searchParams.set("event", "push");
  url.searchParams.set("status", "success");
  url.searchParams.set("head_sha", configuration.sha);
  url.searchParams.set("per_page", "10");
  return url.href;
}

function isMatchingStagingRun(run, expectedSha) {
  return isRecord(run) &&
    run.head_sha === expectedSha &&
    run.head_branch === "main" &&
    run.event === "push" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    (run.path === WORKFLOW_PATH || run.path === WORKFLOW_PATH_ON_MAIN) &&
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_number) &&
    run.run_number > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0;
}

export function parseStagingEvidence(body, expectedSha) {
  if (!LOWERCASE_BUILD_SHA.test(expectedSha)) fail("INVALID_GITHUB_SHA");
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(body.total_count) ||
    body.total_count < 0 ||
    !Array.isArray(body.workflow_runs) ||
    body.workflow_runs.length > 10
  ) {
    fail("INVALID_GITHUB_RESPONSE");
  }
  const matchingRun = body.workflow_runs.find((run) =>
    isMatchingStagingRun(run, expectedSha)
  );
  if (matchingRun === undefined) fail("STAGING_EVIDENCE_NOT_FOUND");
  return {
    runId: matchingRun.id,
    runNumber: matchingRun.run_number,
    runAttempt: matchingRun.run_attempt,
    headSha: matchingRun.head_sha,
  };
}

function githubErrorCode(response, body) {
  if (response.status === 401 || response.status === 403) return "GITHUB_AUTH_FAILED";
  if (response.status === 404) return "GITHUB_WORKFLOW_NOT_FOUND";
  if (response.status === 429) return "GITHUB_RATE_LIMITED";
  if (isRecord(body) && typeof body.message === "string") return "GITHUB_API_FAILED";
  return "GITHUB_API_FAILED";
}

export async function verifyStagingEvidence(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildWorkflowRunsUrl(configuration),
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${configuration.token}`,
        "User-Agent": "firelight-release-evidence",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
    {
      timeoutMs: GITHUB_TIMEOUT_MS,
      maximumBytes: MAX_GITHUB_RESPONSE_BYTES,
    },
  );
  const body = parseJsonBytes(bytes);
  if (!response.ok) fail(githubErrorCode(response, body));
  return parseStagingEvidence(body, configuration.sha);
}

async function main() {
  const configuration = parseStagingEvidenceEnvironment(process.env);
  const evidence = await verifyStagingEvidence(configuration, globalThis.fetch);
  process.stdout.write(
    `Verified staging run ${String(evidence.runId)} for build ${evidence.headSha}.\n`,
  );
}

function isDirectExecution() {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(
      `Staging evidence verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
