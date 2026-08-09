import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  RELEASE_ENVIRONMENT_ANCHORS_SCHEMA,
  RELEASE_ENVIRONMENT_ANCHORS_VERSION,
  parseReleaseEnvironmentAnchors,
  serializeReleaseEnvironmentAnchors,
  validateReleaseEnvironmentAnchors,
} from "./verify-release-environment-anchors.mjs";
import {
  SUPABASE_ORGANIZATION_IDENTITY_DOMAIN,
  SUPABASE_PROJECT_REF_IDENTITY_DOMAIN,
} from "./verify-supabase-project.mjs";

const staging = "a".repeat(64);
const production = "b".repeat(64);

function anchors(overrides = {}) {
  return {
    schema: RELEASE_ENVIRONMENT_ANCHORS_SCHEMA,
    version: RELEASE_ENVIRONMENT_ANCHORS_VERSION,
    projectRefIdentityDomain: SUPABASE_PROJECT_REF_IDENTITY_DOMAIN,
    organizationIdentityDomain: SUPABASE_ORGANIZATION_IDENTITY_DOMAIN,
    organizationIdentitySha256: "c".repeat(64),
    projects: {
      staging: { projectRefIdentitySha256: staging },
      production: { projectRefIdentitySha256: production },
    },
    ...overrides,
  };
}

function hasCode(code) {
  return (error) => error instanceof CanaryError && error.code === code;
}

test("release environment anchors are exact, canonical, and distinct", () => {
  const value = anchors();
  const serialized = serializeReleaseEnvironmentAnchors(value);
  const parsed = parseReleaseEnvironmentAnchors(Buffer.from(serialized));
  assert.equal(parsed.stagingProjectRefIdentityHash, staging);
  assert.equal(parsed.productionProjectRefIdentityHash, production);
  assert.match(parsed.anchorSetSha256, /^[0-9a-f]{64}$/u);
  assert.throws(
    () => parseReleaseEnvironmentAnchors(Buffer.from(` ${serialized}`)),
    hasCode("SUPABASE_ANCHOR_FILE_NONCANONICAL"),
  );
  assert.throws(
    () => validateReleaseEnvironmentAnchors({ ...value, extra: true }),
    hasCode("SUPABASE_ANCHOR_SCHEMA_INVALID"),
  );
  assert.throws(
    () =>
      validateReleaseEnvironmentAnchors(
        anchors({
          projects: {
            staging: { projectRefIdentitySha256: production },
            production: { projectRefIdentitySha256: production },
          },
        }),
      ),
    hasCode("SUPABASE_ANCHOR_PROJECT_COLLISION"),
  );
  assert.throws(
    () =>
      validateReleaseEnvironmentAnchors(
        anchors({ organizationIdentitySha256: "PENDING" }),
      ),
    hasCode("SUPABASE_ANCHOR_VALUE_INVALID"),
  );
});
