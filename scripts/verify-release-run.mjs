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
const BUILD_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/u;
const RELEASES = Object.freeze({
  staging: {
    workflow: "deploy-staging.yml",
    path: ".github/workflows/deploy-staging.yml",
    requiredBranch: "main",
    events: new Set(["push", "workflow_dispatch"]),
  },
  production: {
    workflow: "deploy-production.yml",
    path: ".github/workflows/deploy-production.yml",
    events: new Set(["push", "workflow_dispatch"]),
  },
});

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

export function parseReleaseRunEnvironment(environment) {
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
  const apiUrl = `${parsedApiUrl.origin}${normalizedPath}`;
  if (
    parsedApiUrl.protocol !== "https:" ||
    parsedApiUrl.username !== "" ||
    parsedApiUrl.password !== "" ||
    parsedApiUrl.search !== "" ||
    parsedApiUrl.hash !== "" ||
    rawApiUrl !== apiUrl
  ) {
    fail("INVALID_GITHUB_API_URL");
  }

  const rawRepository = requiredString(environment, "GITHUB_REPOSITORY", 201);
  const segments = rawRepository.split("/");
  if (
    segments.length !== 2 ||
    !validRepositorySegment(segments[0] ?? "") ||
    !validRepositorySegment(segments[1] ?? "")
  ) {
    fail("INVALID_GITHUB_REPOSITORY");
  }

  const token = requiredString(environment, "GITHUB_TOKEN", 4096);
  if (/\s/u.test(token)) fail("INVALID_GITHUB_TOKEN");
  const releaseEnvironment = requiredString(
    environment,
    "FIRELIGHT_RELEASE_ENVIRONMENT",
    10,
  );
  const release = RELEASES[releaseEnvironment];
  if (release === undefined) fail("INVALID_FIRELIGHT_RELEASE_ENVIRONMENT");
  const buildId = requiredString(environment, "FIRELIGHT_RELEASE_BUILD_ID", 40);
  if (!BUILD_SHA.test(buildId)) fail("INVALID_FIRELIGHT_RELEASE_BUILD_ID");

  return {
    apiUrl,
    owner: segments[0],
    repository: segments[1],
    token,
    releaseEnvironment,
    buildId,
    release,
  };
}

export function buildReleaseRunsUrl(configuration) {
  const url = new URL(
    `${configuration.apiUrl}/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repository)}/actions/workflows/${configuration.release.workflow}/runs`,
  );
  url.searchParams.set("status", "success");
  url.searchParams.set("head_sha", configuration.buildId);
  url.searchParams.set("per_page", "10");
  return url.href;
}

function matchesReleaseRun(run, configuration) {
  if (!isRecord(run)) return false;
  const pathMatches = run.path === configuration.release.path ||
    run.path === `${configuration.release.path}@main`;
  return run.head_sha === configuration.buildId &&
    (configuration.release.requiredBranch === undefined ||
      run.head_branch === configuration.release.requiredBranch) &&
    configuration.release.events.has(run.event) &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    pathMatches &&
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0;
}

export function parseReleaseRun(body, configuration) {
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(body.total_count) ||
    body.total_count < 0 ||
    !Array.isArray(body.workflow_runs) ||
    body.workflow_runs.length > 10
  ) {
    fail("INVALID_GITHUB_RESPONSE");
  }
  const matches = body.workflow_runs.filter((run) =>
    matchesReleaseRun(run, configuration)
  );
  if (matches.length < 1) fail("ACCEPTED_RELEASE_RUN_NOT_FOUND");
  return { runId: matches[0].id, headSha: matches[0].head_sha };
}

function githubErrorCode(response) {
  if (response.status === 401 || response.status === 403) return "GITHUB_AUTH_FAILED";
  if (response.status === 404) return "GITHUB_WORKFLOW_NOT_FOUND";
  if (response.status === 429) return "GITHUB_RATE_LIMITED";
  return "GITHUB_API_FAILED";
}

export async function verifyReleaseRun(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildReleaseRunsUrl(configuration),
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${configuration.token}`,
        "User-Agent": "firelight-rollback-evidence",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
    {
      timeoutMs: GITHUB_TIMEOUT_MS,
      maximumBytes: MAX_GITHUB_RESPONSE_BYTES,
    },
  );
  const body = parseJsonBytes(bytes);
  if (!response.ok) fail(githubErrorCode(response));
  return parseReleaseRun(body, configuration);
}

async function main() {
  const configuration = parseReleaseRunEnvironment(process.env);
  const result = await verifyReleaseRun(configuration, globalThis.fetch);
  process.stdout.write(`release_run_id=${String(result.runId)}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Release-run verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
