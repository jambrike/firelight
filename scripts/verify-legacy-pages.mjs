import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_API_RESPONSE_BYTES = 512 * 1024;
const MAX_LEGACY_RESPONSE_BYTES = 128 * 1024;
const ACCOUNT_OR_ZONE_ID = /^[0-9a-f]{32}$/u;
const LOWERCASE_BUILD_SHA = /^[0-9a-f]{40}$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PROJECT_NAME = "firelight";
const PRODUCTION_BRANCH = "main";
const PRODUCTION_DOMAIN = "firelight.ie";

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

function equalDigest(actual, expected) {
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

export function parseLegacyPagesEnvironment(environment) {
  const accountId = requiredString(environment, "CLOUDFLARE_ACCOUNT_ID", 32);
  if (!ACCOUNT_OR_ZONE_ID.test(accountId)) fail("INVALID_CLOUDFLARE_ACCOUNT_ID");
  const zoneId = requiredString(environment, "CLOUDFLARE_ZONE_ID", 32);
  if (!ACCOUNT_OR_ZONE_ID.test(zoneId)) fail("INVALID_CLOUDFLARE_ZONE_ID");
  const apiToken = requiredString(environment, "CLOUDFLARE_API_TOKEN", 4096);
  if (apiToken.length < 20 || /\s/u.test(apiToken)) {
    fail("INVALID_CLOUDFLARE_API_TOKEN");
  }
  const expectedDeploymentId = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_PAGES_DEPLOYMENT_ID",
    36,
  );
  if (!LOWERCASE_UUID.test(expectedDeploymentId)) {
    fail("INVALID_FIRELIGHT_EXPECTED_PAGES_DEPLOYMENT_ID");
  }
  const expectedCommitSha = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_PAGES_COMMIT_SHA",
    40,
  );
  if (!LOWERCASE_BUILD_SHA.test(expectedCommitSha)) {
    fail("INVALID_FIRELIGHT_EXPECTED_PAGES_COMMIT_SHA");
  }
  const expectedEvidenceHash = environment.FIRELIGHT_EXPECTED_LEGACY_PAGES_EVIDENCE_HASH;
  if (
    expectedEvidenceHash !== undefined &&
    (typeof expectedEvidenceHash !== "string" ||
      !LOWERCASE_SHA256.test(expectedEvidenceHash))
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_LEGACY_PAGES_EVIDENCE_HASH");
  }
  const publicMode = environment.FIRELIGHT_LEGACY_PAGES_PUBLIC_MODE ?? "matched";
  if (publicMode !== "matched" && publicMode !== "deployment-only") {
    fail("INVALID_FIRELIGHT_LEGACY_PAGES_PUBLIC_MODE");
  }
  return {
    accountId,
    zoneId,
    apiToken,
    expectedDeploymentId,
    expectedCommitSha,
    publicMode,
    ...(expectedEvidenceHash === undefined ? {} : { expectedEvidenceHash }),
  };
}

function apiUrl(configuration, suffix) {
  return `${CLOUDFLARE_API_BASE_URL}/accounts/${configuration.accountId}/pages/projects/${PROJECT_NAME}${suffix}`;
}

function cloudflareErrorCode(response) {
  if (response.status === 401 || response.status === 403) {
    return "CLOUDFLARE_AUTH_FAILED";
  }
  if (response.status === 404) return "LEGACY_PAGES_PROJECT_NOT_FOUND";
  if (response.status === 429) return "CLOUDFLARE_RATE_LIMITED";
  return "CLOUDFLARE_API_FAILED";
}

async function requestCloudflare(configuration, fetchImpl, suffix) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    apiUrl(configuration, suffix),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.apiToken}`,
        "User-Agent": "firelight-legacy-pages-verifier",
      },
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumBytes: MAX_API_RESPONSE_BYTES,
    },
  );
  const body = parseJsonBytes(bytes);
  if (!response.ok) fail(cloudflareErrorCode(response));
  if (
    !isRecord(body) ||
    body.success !== true ||
    !Array.isArray(body.errors) ||
    body.errors.length !== 0 ||
    !Array.isArray(body.messages)
  ) {
    fail("INVALID_CLOUDFLARE_RESPONSE");
  }
  return body.result;
}

function validateProject(result, configuration) {
  const pagesDomains = isRecord(result) && Array.isArray(result.domains)
    ? result.domains.filter((domain) =>
        typeof domain === "string" &&
        /^firelight(?:-[a-z0-9]+)?\.pages\.dev$/u.test(domain)
      )
    : [];
  if (
    !isRecord(result) ||
    result.name !== PROJECT_NAME ||
    result.production_branch !== PRODUCTION_BRANCH ||
    !Array.isArray(result.domains) ||
    result.domains.filter((domain) => domain === PRODUCTION_DOMAIN).length !== 1 ||
    pagesDomains.length !== 1 ||
    (result.source !== undefined && result.source !== null) ||
    !isRecord(result.canonical_deployment)
  ) {
    fail("LEGACY_PAGES_PROJECT_MISMATCH");
  }
  const deployment = result.canonical_deployment;
  if (
    deployment.id !== configuration.expectedDeploymentId ||
    deployment.project_name !== PROJECT_NAME ||
    deployment.environment !== "production" ||
    deployment.is_skipped !== false ||
    !isRecord(deployment.deployment_trigger) ||
    deployment.deployment_trigger.type !== "ad_hoc" ||
    !isRecord(deployment.deployment_trigger.metadata) ||
    deployment.deployment_trigger.metadata.branch !== PRODUCTION_BRANCH ||
    deployment.deployment_trigger.metadata.commit_hash !==
      configuration.expectedCommitSha ||
    !isRecord(deployment.latest_stage) ||
    deployment.latest_stage.name !== "deploy" ||
    deployment.latest_stage.status !== "success" ||
    typeof deployment.url !== "string" ||
    deployment.url.length > 2048
  ) {
    fail("LEGACY_PAGES_DEPLOYMENT_MISMATCH");
  }
  let deploymentUrl;
  try {
    deploymentUrl = new URL(deployment.url);
  } catch {
    fail("LEGACY_PAGES_DEPLOYMENT_MISMATCH");
  }
  if (
    deploymentUrl.protocol !== "https:" ||
    deploymentUrl.port !== "" ||
    deploymentUrl.username !== "" ||
    deploymentUrl.password !== "" ||
    (deploymentUrl.hostname !== pagesDomains[0] &&
      !deploymentUrl.hostname.endsWith(`.${pagesDomains[0]}`)) ||
    deploymentUrl.pathname !== "/" ||
    deploymentUrl.search !== "" ||
    deploymentUrl.hash !== ""
  ) {
    fail("LEGACY_PAGES_DEPLOYMENT_MISMATCH");
  }
  return deploymentUrl.origin;
}

function validateDomain(result, configuration) {
  if (!Array.isArray(result) || result.length > 1_000) {
    fail("INVALID_LEGACY_PAGES_DOMAINS");
  }
  const matches = result.filter((domain) =>
    isRecord(domain) && domain.name === PRODUCTION_DOMAIN
  );
  if (
    matches.length !== 1 ||
    matches[0].status !== "active" ||
    matches[0].zone_tag !== configuration.zoneId ||
    !isRecord(matches[0].verification_data) ||
    matches[0].verification_data.status !== "active"
  ) {
    fail("LEGACY_PAGES_DOMAIN_MISMATCH");
  }
}

async function fetchLegacyContent(fetchImpl, url, path, accept, contentTypePattern) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    `${url}${path}`,
    {
      method: "GET",
      headers: { Accept: accept },
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumBytes: MAX_LEGACY_RESPONSE_BYTES,
    },
  );
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.status !== 200 ||
    !contentTypePattern.test(contentType) ||
    bytes.byteLength === 0
  ) {
    fail("LEGACY_PAGES_CONTENT_MISMATCH");
  }
  return bytes;
}

function fetchLegacyHtml(fetchImpl, url) {
  return fetchLegacyContent(
    fetchImpl,
    url,
    "/api/config",
    "text/html",
    /^text\/html(?:\s*;|$)/iu,
  );
}

function fetchLegacyAsset(fetchImpl, url) {
  return fetchLegacyContent(
    fetchImpl,
    url,
    "/favicon.svg",
    "image/svg+xml",
    /^image\/svg\+xml(?:\s*;|$)/iu,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyLegacyPages(configuration, fetchImpl) {
  const project = await requestCloudflare(configuration, fetchImpl, "");
  const deploymentOrigin = validateProject(project, configuration);
  const domains = await requestCloudflare(configuration, fetchImpl, "/domains");
  validateDomain(domains, configuration);

  await fetchLegacyHtml(fetchImpl, deploymentOrigin);
  const deploymentAssetBytes = await fetchLegacyAsset(fetchImpl, deploymentOrigin);
  const deploymentAssetHash = sha256(deploymentAssetBytes);
  let legacyAssetHash = deploymentAssetHash;
  if (configuration.publicMode === "matched") {
    await fetchLegacyHtml(
      fetchImpl,
      `https://${PRODUCTION_DOMAIN}`,
    );
    const publicAssetBytes = await fetchLegacyAsset(
      fetchImpl,
      `https://${PRODUCTION_DOMAIN}`,
    );
    legacyAssetHash = sha256(publicAssetBytes);
    if (!equalDigest(deploymentAssetHash, legacyAssetHash)) {
      fail("LEGACY_PAGES_CONTENT_MISMATCH");
    }
  }

  const evidenceHash = sha256(Buffer.from(JSON.stringify({
    accountId: configuration.accountId,
    zoneId: configuration.zoneId,
    project: PROJECT_NAME,
    source: "direct-upload",
    productionBranch: PRODUCTION_BRANCH,
    domain: PRODUCTION_DOMAIN,
    deploymentId: configuration.expectedDeploymentId,
    commitSha: configuration.expectedCommitSha,
    legacyAssetHash,
  }), "utf8"));
  if (
    configuration.expectedEvidenceHash !== undefined &&
    !equalDigest(evidenceHash, configuration.expectedEvidenceHash)
  ) {
    fail("LEGACY_PAGES_EVIDENCE_MISMATCH");
  }
  return {
    evidenceHash,
    legacyAssetHash,
    deploymentId: configuration.expectedDeploymentId,
    commitSha: configuration.expectedCommitSha,
    publicMode: configuration.publicMode,
  };
}

async function main() {
  const configuration = parseLegacyPagesEnvironment(process.env);
  const result = await verifyLegacyPages(configuration, globalThis.fetch);
  process.stdout.write(`legacy_pages_evidence_hash=${result.evidenceHash}\n`);
  process.stdout.write(`legacy_asset_hash=${result.legacyAssetHash}\n`);
  process.stdout.write(`legacy_pages_deployment_id=${result.deploymentId}\n`);
  process.stdout.write(`legacy_pages_commit_sha=${result.commitSha}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Legacy Pages verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
