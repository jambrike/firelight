import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CANONICAL_REPOSITORY,
  WEB_STAGING_WORKFLOW_PATH,
  webStagingArtifactName,
} from "./capture-web-staging-evidence.mjs";
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
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const PRODUCTION_WORKFLOW_REF =
  `${CANONICAL_REPOSITORY}/.github/workflows/deploy-production.yml@refs/heads/main`;
const WORKFLOW_PATH_ON_MAIN = `${WEB_STAGING_WORKFLOW_PATH}@main`;
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_SERVER_URL = "https://github.com";

function fail(code) {
  throw new CanaryError(code);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requiredString(environment, name, maximum = 4096) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    fail(`INVALID_${name}`);
  }
  return value;
}

function requireExact(environment, name, expected) {
  if (requiredString(environment, name, expected.length) !== expected) {
    fail(`INVALID_${name}`);
  }
}

function positiveInteger(environment, name) {
  const raw = requiredString(environment, name, 16);
  if (!POSITIVE_INTEGER.test(raw)) fail(`INVALID_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`INVALID_${name}`);
  return value;
}

export function parseStagingEvidenceEnvironment(environment) {
  requireExact(environment, "GITHUB_ACTIONS", "true");
  requireExact(environment, "GITHUB_SERVER_URL", GITHUB_SERVER_URL);
  requireExact(environment, "GITHUB_API_URL", GITHUB_API_URL);
  requireExact(environment, "GITHUB_EVENT_NAME", "workflow_dispatch");
  requireExact(environment, "GITHUB_REPOSITORY", CANONICAL_REPOSITORY);
  requireExact(environment, "GITHUB_REF", "refs/heads/main");
  requireExact(environment, "GITHUB_WORKFLOW_REF", PRODUCTION_WORKFLOW_REF);

  const sha = requiredString(environment, "GITHUB_SHA", 40);
  if (!BUILD_SHA.test(sha)) fail("INVALID_GITHUB_SHA");
  const workflowSha = requiredString(environment, "GITHUB_WORKFLOW_SHA", 40);
  if (!BUILD_SHA.test(workflowSha) || workflowSha !== sha) {
    fail("INVALID_GITHUB_WORKFLOW_SHA");
  }
  const token = requiredString(environment, "GITHUB_TOKEN", 4096);
  if (/\s/u.test(token)) fail("INVALID_GITHUB_TOKEN");
  const expectedRunId = positiveInteger(environment, "FIRELIGHT_STAGING_RUN_ID");

  return {
    apiUrl: GITHUB_API_URL,
    owner: "jambrike",
    repository: "firelight",
    sha,
    token,
    expectedRunId,
  };
}

export function buildWorkflowRunUrl(configuration) {
  return `${configuration.apiUrl}/repos/${configuration.owner}/${configuration.repository}/actions/runs/${String(configuration.expectedRunId)}`;
}

function isMatchingStagingRun(run, configuration) {
  return (
    isRecord(run) &&
    run.id === configuration.expectedRunId &&
    run.head_sha === configuration.sha &&
    run.head_branch === "main" &&
    run.event === "workflow_dispatch" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    (run.path === WEB_STAGING_WORKFLOW_PATH ||
      run.path === WORKFLOW_PATH_ON_MAIN) &&
    isRecord(run.repository) &&
    run.repository.full_name === CANONICAL_REPOSITORY &&
    Number.isSafeInteger(run.repository.id) &&
    run.repository.id > 0 &&
    Number.isSafeInteger(run.run_number) &&
    run.run_number > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  );
}

export function parseStagingEvidence(body, configuration) {
  if (!isMatchingStagingRun(body, configuration)) {
    fail("STAGING_RUN_MISMATCH");
  }
  return {
    runId: body.id,
    runNumber: body.run_number,
    runAttempt: body.run_attempt,
    headSha: body.head_sha,
    repositoryId: body.repository.id,
    artifactName: webStagingArtifactName(body.id, body.run_attempt),
  };
}

function githubErrorCode(status) {
  if (status === 401 || status === 403) return "GITHUB_AUTH_FAILED";
  if (status === 404) return "STAGING_RUN_NOT_FOUND";
  if (status === 429) return "GITHUB_RATE_LIMITED";
  return "GITHUB_API_FAILED";
}

export async function verifyStagingEvidence(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildWorkflowRunUrl(configuration),
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${configuration.token}`,
        "User-Agent": "firelight-web-staging-evidence",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
    {
      timeoutMs: GITHUB_TIMEOUT_MS,
      maximumBytes: MAX_GITHUB_RESPONSE_BYTES,
    },
  );
  if (!response.ok) fail(githubErrorCode(response.status));
  return parseStagingEvidence(parseJsonBytes(bytes), configuration);
}

async function main() {
  const configuration = parseStagingEvidenceEnvironment(process.env);
  const evidence = await verifyStagingEvidence(configuration, globalThis.fetch);
  process.stdout.write(
    `staging_run_id=${String(evidence.runId)}\n` +
      `staging_run_number=${String(evidence.runNumber)}\n` +
      `staging_run_attempt=${String(evidence.runAttempt)}\n` +
      `staging_artifact_name=${evidence.artifactName}\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Staging run verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
