import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";
import {
  buildAuthAdminUserUrl,
  buildCanaryActivationUrl,
  buildPrincipalProfilesUrl,
  parseReleasePrincipalsEnvironment,
  validateAuthPrincipal,
  validateCanaryActivation,
  verifyReleasePrincipals,
} from "./verify-release-principals.mjs";

const CONFIRMATIONS = Object.freeze({
  staging: "BOOTSTRAP_STAGING_RELEASE_PRINCIPALS",
  production: "BOOTSTRAP_PRODUCTION_RELEASE_PRINCIPALS",
});
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

function fail(code) {
  throw new CanaryError(code);
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    RFC3339_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSafeDisplayName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 40 ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

export function parseReleasePrincipalsBootstrapEnvironment(environment) {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  const confirmation = environment.FIRELIGHT_RELEASE_PRINCIPALS_BOOTSTRAP_CONFIRMATION;
  if (
    typeof confirmation !== "string" ||
    confirmation !== CONFIRMATIONS[configuration.expectedEnvironment]
  ) {
    fail("RELEASE_PRINCIPALS_BOOTSTRAP_CONFIRMATION_MISMATCH");
  }
  return configuration;
}

export function buildSupportAdminPromotionUrl(configuration) {
  const url = new URL("/rest/v1/profiles", configuration.projectOrigin);
  url.searchParams.set("id", `eq.${configuration.supportAdmin.id}`);
  url.searchParams.set("role", "eq.learner");
  url.searchParams.set("access_source", "eq.grandfathered");
  return url.href;
}

function serviceHeaders(configuration, method) {
  return {
    Accept: "application/json",
    apikey: configuration.serviceRoleKey,
    Authorization: `Bearer ${configuration.serviceRoleKey}`,
    "User-Agent": "firelight-release-principals-bootstrap",
    ...(method === "GET"
      ? { "Accept-Profile": "public" }
      : {
          "Content-Profile": "public",
          "Content-Type": "application/json; charset=utf-8",
          Prefer: "return=representation,handling=strict",
        }),
  };
}

function bootstrapRequestErrorCode(status) {
  if (status === 401 || status === 403) {
    return "SUPABASE_RELEASE_PRINCIPALS_BOOTSTRAP_ACCESS_DENIED";
  }
  if (status === 404) return "SUPABASE_RELEASE_PRINCIPALS_BOOTSTRAP_NOT_FOUND";
  if (status === 409 || status === 412) {
    return "SUPPORT_ADMIN_PROMOTION_CONFLICT";
  }
  if (status === 429) return "SUPABASE_RELEASE_PRINCIPALS_RATE_LIMITED";
  return "SUPABASE_RELEASE_PRINCIPALS_BOOTSTRAP_REQUEST_FAILED";
}

async function requestBootstrapJson(
  configuration,
  fetchImpl,
  input,
  { method = "GET", body } = {},
) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    input,
    {
      method,
      headers: serviceHeaders(configuration, method),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, maximumBytes: MAX_RESPONSE_BYTES },
  );
  if (!response.ok) fail(bootstrapRequestErrorCode(response.status));
  return parseJsonBytes(bytes);
}

export function validateBootstrapProfiles(value, configuration) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail("RELEASE_PRINCIPALS_BOOTSTRAP_PROFILE_MISMATCH");
  }
  const profiles = new Map();
  for (const profile of value) {
    if (!isRecord(profile) || typeof profile.id !== "string" || profiles.has(profile.id)) {
      fail("RELEASE_PRINCIPALS_BOOTSTRAP_PROFILE_MISMATCH");
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
    fail("CANARY_BOOTSTRAP_PRESTATE_UNSAFE");
  }
  if (
    !isRecord(supportAdmin) ||
    (supportAdmin.role !== "learner" && supportAdmin.role !== "admin") ||
    supportAdmin.access_source !== "grandfathered" ||
    !isTimestamp(supportAdmin.access_granted_at) ||
    !isSafeDisplayName(supportAdmin.display_name) ||
    (supportAdmin.role === "admin" &&
      supportAdmin.display_name !== configuration.supportAdmin.displayName)
  ) {
    fail("SUPPORT_ADMIN_BOOTSTRAP_PRESTATE_UNSAFE");
  }
  return {
    canaryAccessSource: canary.access_source,
    canaryAccessGrantedAt: canary.access_granted_at,
    supportAdminRole: supportAdmin.role,
    supportAdminAccessGrantedAt: supportAdmin.access_granted_at,
  };
}

export function validatePromotedSupportProfile(
  value,
  configuration,
  prestate,
) {
  if (!Array.isArray(value) || value.length !== 1) {
    fail("SUPPORT_ADMIN_PROMOTION_CONFLICT");
  }
  const profile = value[0];
  if (
    !isRecord(profile) ||
    profile.id !== configuration.supportAdmin.id ||
    profile.display_name !== configuration.supportAdmin.displayName ||
    profile.role !== "admin" ||
    profile.access_source !== "grandfathered" ||
    profile.access_granted_at !== prestate.supportAdminAccessGrantedAt
  ) {
    fail("SUPPORT_ADMIN_PROMOTION_RESPONSE_MISMATCH");
  }
  return { id: profile.id };
}

export async function bootstrapReleasePrincipals(configuration, fetchImpl) {
  validateAuthPrincipal(
    await requestBootstrapJson(
      configuration,
      fetchImpl,
      buildAuthAdminUserUrl(configuration, configuration.canary.id),
    ),
    configuration.canary,
    "canary",
  );
  validateAuthPrincipal(
    await requestBootstrapJson(
      configuration,
      fetchImpl,
      buildAuthAdminUserUrl(configuration, configuration.supportAdmin.id),
    ),
    configuration.supportAdmin,
    "supportAdmin",
  );
  const prestate = validateBootstrapProfiles(
    await requestBootstrapJson(
      configuration,
      fetchImpl,
      buildPrincipalProfilesUrl(configuration),
    ),
    configuration,
  );
  validateCanaryActivation(
    await requestBootstrapJson(
      configuration,
      fetchImpl,
      buildCanaryActivationUrl(configuration),
    ),
    configuration,
    prestate,
  );

  let promoted = false;
  if (prestate.supportAdminRole === "learner") {
    validatePromotedSupportProfile(
      await requestBootstrapJson(
        configuration,
        fetchImpl,
        buildSupportAdminPromotionUrl(configuration),
        {
          method: "PATCH",
          body: {
            role: "admin",
            display_name: configuration.supportAdmin.displayName,
          },
        },
      ),
      configuration,
      prestate,
    );
    promoted = true;
  }

  const verification = await verifyReleasePrincipals(configuration, fetchImpl);
  return {
    ...verification,
    promoted,
  };
}

async function main() {
  const configuration = parseReleasePrincipalsBootstrapEnvironment(process.env);
  const result = await bootstrapReleasePrincipals(configuration, globalThis.fetch);
  process.stdout.write(
    `release_principals_hash=${result.releasePrincipalsHash}\n` +
      `release_principal_bindings_hash=${result.bindingsHash}\n` +
      "release_principals_bootstrap=verified\n",
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Supabase release-principal bootstrap failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
