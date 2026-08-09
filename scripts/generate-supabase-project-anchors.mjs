import process from "node:process";
import { pathToFileURL } from "node:url";
import { CanaryError, safeCanaryErrorCode } from "./postdeploy-canary.mjs";
import {
  RELEASE_ENVIRONMENT_ANCHORS_SCHEMA,
  RELEASE_ENVIRONMENT_ANCHORS_VERSION,
  serializeReleaseEnvironmentAnchors,
  validateReleaseEnvironmentAnchors,
} from "./verify-release-environment-anchors.mjs";
import {
  SUPABASE_ORGANIZATION_IDENTITY_DOMAIN,
  SUPABASE_PROJECT_REF_IDENTITY_DOMAIN,
  organizationIdentityHash,
  projectRefIdentityHash,
} from "./verify-supabase-project.mjs";

const PROJECT_REF = /^[a-z0-9]{20}$/u;
const ORGANIZATION_ID = /^[A-Za-z0-9_-]{4,128}$/u;

function fail(code) {
  throw new CanaryError(code);
}

function required(environment, name, pattern) {
  const value = environment[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`INVALID_${name}`);
  }
  return value;
}

export function generateSupabaseProjectAnchors(environment) {
  const organizationId = required(
    environment,
    "SUPABASE_ORGANIZATION_ID",
    ORGANIZATION_ID,
  );
  const stagingProjectRef = required(
    environment,
    "FIRELIGHT_STAGING_SUPABASE_PROJECT_REF",
    PROJECT_REF,
  );
  const productionProjectRef = required(
    environment,
    "FIRELIGHT_PRODUCTION_SUPABASE_PROJECT_REF",
    PROJECT_REF,
  );
  if (stagingProjectRef === productionProjectRef) {
    fail("SUPABASE_PROJECT_REF_COLLISION");
  }
  return validateReleaseEnvironmentAnchors({
    schema: RELEASE_ENVIRONMENT_ANCHORS_SCHEMA,
    version: RELEASE_ENVIRONMENT_ANCHORS_VERSION,
    projectRefIdentityDomain: SUPABASE_PROJECT_REF_IDENTITY_DOMAIN,
    organizationIdentityDomain: SUPABASE_ORGANIZATION_IDENTITY_DOMAIN,
    organizationIdentitySha256: organizationIdentityHash({ organizationId }),
    projects: {
      staging: {
        projectRefIdentitySha256: projectRefIdentityHash({
          projectRef: stagingProjectRef,
        }),
      },
      production: {
        projectRefIdentitySha256: projectRefIdentityHash({
          projectRef: productionProjectRef,
        }),
      },
    },
  });
}

async function main() {
  const value = generateSupabaseProjectAnchors(process.env);
  process.stdout.write(serializeReleaseEnvironmentAnchors(value));
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Supabase anchor generation failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
