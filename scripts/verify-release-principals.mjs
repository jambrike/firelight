import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const PROJECT_REF = /^[a-z0-9]{20}$/u;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AUTH_RESPONSE_BYTES = 128 * 1024;
const MAX_REST_RESPONSE_BYTES = 64 * 1024;

function fail(code) {
  throw new CanaryError(code);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function requiredString(environment, name, maximum) {
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

function requiredUuid(environment, name) {
  const value = requiredString(environment, name, 36);
  if (!LOWERCASE_UUID.test(value)) fail(`INVALID_${name}`);
  return value;
}

function requiredEmail(environment, name) {
  const value = requiredString(environment, name, 320);
  if (value !== value.toLowerCase() || !EMAIL.test(value)) {
    fail(`INVALID_${name}`);
  }
  return value;
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    RFC3339_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function principalBindingsHash(configuration) {
  const canonical = JSON.stringify({
    version: 1,
    environment: configuration.expectedEnvironment,
    projectRef: configuration.projectRef,
    canary: {
      id: configuration.canary.id,
      email: configuration.canary.email,
    },
    supportAdmin: {
      id: configuration.supportAdmin.id,
      email: configuration.supportAdmin.email,
      displayName: configuration.supportAdmin.displayName,
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function parseReleasePrincipalsEnvironment(environment) {
  const expectedEnvironment = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_ENVIRONMENT",
    10,
  );
  if (expectedEnvironment !== "staging" && expectedEnvironment !== "production") {
    fail("INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT");
  }

  const projectRef = requiredString(environment, "SUPABASE_PROJECT_REF", 20);
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");

  const serviceRoleKey = requiredString(
    environment,
    "SUPABASE_SERVICE_ROLE_KEY",
    8192,
  );
  if (serviceRoleKey.length < 20 || /\s/u.test(serviceRoleKey)) {
    fail("INVALID_SUPABASE_SERVICE_ROLE_KEY");
  }

  const canary = {
    id: requiredUuid(environment, "FIRELIGHT_CANARY_USER_ID"),
    email: requiredEmail(environment, "FIRELIGHT_CANARY_EMAIL"),
  };
  const supportAdmin = {
    id: requiredUuid(environment, "FIRELIGHT_SUPPORT_ADMIN_USER_ID"),
    email: requiredEmail(environment, "FIRELIGHT_SUPPORT_ADMIN_EMAIL"),
    displayName: requiredString(
      environment,
      "FIRELIGHT_SUPPORT_ADMIN_DISPLAY_NAME",
      40,
    ),
  };
  if (canary.id === supportAdmin.id || canary.email === supportAdmin.email) {
    fail("RELEASE_PRINCIPALS_NOT_DISTINCT");
  }

  const expectedHash = environment.FIRELIGHT_EXPECTED_RELEASE_PRINCIPALS_HASH;
  if (
    expectedHash !== undefined &&
    (typeof expectedHash !== "string" || !LOWERCASE_SHA256.test(expectedHash))
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_RELEASE_PRINCIPALS_HASH");
  }

  const configuration = {
    expectedEnvironment,
    projectRef,
    projectOrigin: `https://${projectRef}.supabase.co`,
    serviceRoleKey,
    canary,
    supportAdmin,
    expectedHash,
  };
  return {
    ...configuration,
    bindingsHash: principalBindingsHash(configuration),
  };
}

export function buildAuthAdminUserUrl(configuration, userId) {
  if (!LOWERCASE_UUID.test(userId)) fail("INVALID_RELEASE_PRINCIPAL_USER_ID");
  return `${configuration.projectOrigin}/auth/v1/admin/users/${userId}`;
}

export function buildPrincipalProfilesUrl(configuration) {
  const url = new URL("/rest/v1/profiles", configuration.projectOrigin);
  url.searchParams.set(
    "select",
    "id,display_name,role,access_source,access_granted_at",
  );
  url.searchParams.set(
    "id",
    `in.(${configuration.canary.id},${configuration.supportAdmin.id})`,
  );
  url.searchParams.set("order", "id.asc");
  url.searchParams.set("limit", "2");
  return url.href;
}

export function buildCanaryActivationUrl(configuration) {
  const url = new URL("/rest/v1/kit_codes", configuration.projectOrigin);
  url.searchParams.set(
    "select",
    "id,kind,state,claimed_by,claimed_at,revoked_at",
  );
  url.searchParams.set("claimed_by", `eq.${configuration.canary.id}`);
  url.searchParams.set("state", "eq.claimed");
  url.searchParams.set("order", "id.asc");
  url.searchParams.set("limit", "2");
  return url.href;
}

export function validateAuthPrincipal(value, expected, kind) {
  const mismatchCode = kind === "canary"
    ? "CANARY_AUTH_IDENTITY_MISMATCH"
    : "SUPPORT_ADMIN_AUTH_IDENTITY_MISMATCH";
  const unconfirmedCode = kind === "canary"
    ? "CANARY_AUTH_NOT_CONFIRMED"
    : "SUPPORT_ADMIN_AUTH_NOT_CONFIRMED";
  const disabledCode = kind === "canary"
    ? "CANARY_AUTH_DISABLED"
    : "SUPPORT_ADMIN_AUTH_DISABLED";

  if (
    !isRecord(value) ||
    value.id !== expected.id ||
    value.email !== expected.email ||
    value.aud !== "authenticated" ||
    value.role !== "authenticated" ||
    value.is_anonymous !== false
  ) {
    fail(mismatchCode);
  }
  if (!isTimestamp(value.email_confirmed_at)) fail(unconfirmedCode);
  if (
    (value.banned_until !== undefined && value.banned_until !== null) ||
    (value.deleted_at !== undefined && value.deleted_at !== null)
  ) {
    fail(disabledCode);
  }
  return {
    id: value.id,
    emailConfirmedAt: value.email_confirmed_at,
  };
}

export function validatePrincipalProfiles(value, configuration) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail("RELEASE_PRINCIPAL_PROFILES_MISMATCH");
  }
  const profiles = new Map();
  for (const profile of value) {
    if (!isRecord(profile) || typeof profile.id !== "string" || profiles.has(profile.id)) {
      fail("RELEASE_PRINCIPAL_PROFILES_MISMATCH");
    }
    profiles.set(profile.id, profile);
  }
  const canary = profiles.get(configuration.canary.id);
  const supportAdmin = profiles.get(configuration.supportAdmin.id);
  if (
    !isRecord(canary) ||
    canary.role !== "learner" ||
    (canary.access_source !== "code" && canary.access_source !== "grandfathered") ||
    !isTimestamp(canary.access_granted_at)
  ) {
    fail("CANARY_PROFILE_NOT_ACTIVATED_LEARNER");
  }
  if (
    !isRecord(supportAdmin) ||
    supportAdmin.role !== "admin" ||
    supportAdmin.display_name !== configuration.supportAdmin.displayName
  ) {
    fail("SUPPORT_ADMIN_PROFILE_MISMATCH");
  }
  return {
    canaryAccessSource: canary.access_source,
    canaryAccessGrantedAt: canary.access_granted_at,
  };
}

export function validateCanaryActivation(value, configuration, profileProof) {
  if (!Array.isArray(value)) fail("CANARY_ACTIVATION_MISMATCH");
  if (profileProof.canaryAccessSource === "grandfathered") {
    if (value.length !== 0) fail("CANARY_ACTIVATION_MISMATCH");
    return {
      kind: "grandfathered",
      id: configuration.canary.id,
      claimedAt: profileProof.canaryAccessGrantedAt,
    };
  }
  if (profileProof.canaryAccessSource !== "code" || value.length !== 1) {
    fail("CANARY_ACTIVATION_MISMATCH");
  }
  const activation = value[0];
  if (
    !isRecord(activation) ||
    !LOWERCASE_UUID.test(activation.id) ||
    activation.kind !== "code" ||
    activation.state !== "claimed" ||
    activation.claimed_by !== configuration.canary.id ||
    !isTimestamp(activation.claimed_at) ||
    activation.claimed_at !== profileProof.canaryAccessGrantedAt ||
    activation.revoked_at !== null
  ) {
    fail("CANARY_ACTIVATION_MISMATCH");
  }
  return {
    kind: "code",
    id: activation.id,
    claimedAt: activation.claimed_at,
  };
}

function requestErrorCode(scope, status) {
  if (status === 401 || status === 403) {
    return scope === "auth"
      ? "SUPABASE_AUTH_ADMIN_ACCESS_DENIED"
      : "SUPABASE_RELEASE_DATA_ACCESS_DENIED";
  }
  if (status === 404) {
    return scope === "auth"
      ? "SUPABASE_RELEASE_AUTH_USER_NOT_FOUND"
      : "SUPABASE_RELEASE_DATA_NOT_FOUND";
  }
  if (status === 429) return "SUPABASE_RELEASE_PRINCIPALS_RATE_LIMITED";
  return scope === "auth"
    ? "SUPABASE_AUTH_ADMIN_REQUEST_FAILED"
    : "SUPABASE_RELEASE_DATA_REQUEST_FAILED";
}

function releaseHeaders(configuration, scope) {
  return {
    Accept: "application/json",
    apikey: configuration.serviceRoleKey,
    Authorization: `Bearer ${configuration.serviceRoleKey}`,
    "User-Agent": "firelight-release-principals-verifier",
    ...(scope === "rest" ? { "Accept-Profile": "public" } : {}),
  };
}

async function requestReleaseJson(configuration, fetchImpl, input, scope) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    input,
    {
      method: "GET",
      headers: releaseHeaders(configuration, scope),
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumBytes: scope === "auth"
        ? MAX_AUTH_RESPONSE_BYTES
        : MAX_REST_RESPONSE_BYTES,
    },
  );
  if (!response.ok) fail(requestErrorCode(scope, response.status));
  return parseJsonBytes(bytes);
}

function verifiedStateHash(configuration, authProofs, profileProof, activationProof) {
  const canonical = JSON.stringify({
    version: 1,
    bindingsHash: configuration.bindingsHash,
    canary: {
      id: configuration.canary.id,
      emailConfirmedAt: authProofs.canary.emailConfirmedAt,
      role: "learner",
      accessSource: profileProof.canaryAccessSource,
      accessGrantedAt: profileProof.canaryAccessGrantedAt,
      activation: activationProof,
    },
    supportAdmin: {
      id: configuration.supportAdmin.id,
      emailConfirmedAt: authProofs.supportAdmin.emailConfirmedAt,
      role: "admin",
      displayName: configuration.supportAdmin.displayName,
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function verifyReleasePrincipals(configuration, fetchImpl) {
  const canaryAuth = validateAuthPrincipal(
    await requestReleaseJson(
      configuration,
      fetchImpl,
      buildAuthAdminUserUrl(configuration, configuration.canary.id),
      "auth",
    ),
    configuration.canary,
    "canary",
  );
  const supportAdminAuth = validateAuthPrincipal(
    await requestReleaseJson(
      configuration,
      fetchImpl,
      buildAuthAdminUserUrl(configuration, configuration.supportAdmin.id),
      "auth",
    ),
    configuration.supportAdmin,
    "supportAdmin",
  );
  const profileProof = validatePrincipalProfiles(
    await requestReleaseJson(
      configuration,
      fetchImpl,
      buildPrincipalProfilesUrl(configuration),
      "rest",
    ),
    configuration,
  );
  const activationProof = validateCanaryActivation(
    await requestReleaseJson(
      configuration,
      fetchImpl,
      buildCanaryActivationUrl(configuration),
      "rest",
    ),
    configuration,
    profileProof,
  );
  const releasePrincipalsHash = verifiedStateHash(
    configuration,
    { canary: canaryAuth, supportAdmin: supportAdminAuth },
    profileProof,
    activationProof,
  );
  if (
    configuration.expectedHash !== undefined &&
    configuration.expectedHash !== releasePrincipalsHash
  ) {
    fail("RELEASE_PRINCIPALS_EVIDENCE_MISMATCH");
  }
  return {
    bindingsHash: configuration.bindingsHash,
    releasePrincipalsHash,
  };
}

async function main() {
  const configuration = parseReleasePrincipalsEnvironment(process.env);
  const result = await verifyReleasePrincipals(configuration, globalThis.fetch);
  process.stdout.write(
    `release_principals_hash=${result.releasePrincipalsHash}\n` +
      `release_principal_bindings_hash=${result.bindingsHash}\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Supabase release-principal verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
