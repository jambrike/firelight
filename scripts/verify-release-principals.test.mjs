import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildAuthAdminUserUrl,
  buildCanaryActivationUrl,
  buildPrincipalProfilesUrl,
  parseReleasePrincipalsEnvironment,
  validateAuthPrincipal,
  validateCanaryActivation,
  validatePrincipalProfiles,
  verifyReleasePrincipals,
} from "./verify-release-principals.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const SERVICE_ROLE_KEY = "supabase-service-role-key-that-must-never-leak";
const CANARY_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVATION_ID = "33333333-3333-4333-8333-333333333333";
const CANARY_EMAIL = "release-canary@auth.firelight.ie";
const ADMIN_EMAIL = "ada.lovelace@firelight.ie";
const ADMIN_NAME = "Ada Lovelace";
const CONFIRMED_AT = "2026-08-01T09:00:00.000Z";
const ACTIVATED_AT = "2026-08-01T10:00:00.000Z";

const environment = {
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
  SUPABASE_PROJECT_REF: PROJECT_REF,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  FIRELIGHT_CANARY_USER_ID: CANARY_ID,
  FIRELIGHT_CANARY_EMAIL: CANARY_EMAIL,
  FIRELIGHT_SUPPORT_ADMIN_USER_ID: ADMIN_ID,
  FIRELIGHT_SUPPORT_ADMIN_EMAIL: ADMIN_EMAIL,
  FIRELIGHT_SUPPORT_ADMIN_DISPLAY_NAME: ADMIN_NAME,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(SERVICE_ROLE_KEY), false);
    assert.equal(error.message.includes(CANARY_EMAIL), false);
    assert.equal(error.message.includes(ADMIN_EMAIL), false);
    return true;
  };
}

function authUser(id, email, overrides = {}) {
  return {
    id,
    email,
    aud: "authenticated",
    role: "authenticated",
    is_anonymous: false,
    email_confirmed_at: CONFIRMED_AT,
    banned_until: null,
    deleted_at: null,
    ...overrides,
  };
}

function profileRows(overrides = {}) {
  return [
    {
      id: CANARY_ID,
      display_name: "Release Canary",
      role: "learner",
      access_source: "code",
      access_granted_at: ACTIVATED_AT,
      ...overrides.canary,
    },
    {
      id: ADMIN_ID,
      display_name: ADMIN_NAME,
      role: "admin",
      access_source: null,
      access_granted_at: null,
      ...overrides.admin,
    },
  ];
}

function activationRows(overrides = {}) {
  return [{
    id: ACTIVATION_ID,
    kind: "code",
    state: "claimed",
    claimed_by: CANARY_ID,
    claimed_at: ACTIVATED_AT,
    revoked_at: null,
    ...overrides,
  }];
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulFetch({ profiles = profileRows(), activations = activationRows() } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(url.origin, `https://${PROJECT_REF}.supabase.co`);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.apikey, SERVICE_ROLE_KEY);
    assert.equal(init.headers.Authorization, `Bearer ${SERVICE_ROLE_KEY}`);
    assert.equal(init.redirect, "error");
    if (url.pathname === `/auth/v1/admin/users/${CANARY_ID}`) {
      return jsonResponse(authUser(CANARY_ID, CANARY_EMAIL));
    }
    if (url.pathname === `/auth/v1/admin/users/${ADMIN_ID}`) {
      return jsonResponse(authUser(ADMIN_ID, ADMIN_EMAIL));
    }
    if (url.pathname === "/rest/v1/profiles") {
      assert.equal(init.headers["Accept-Profile"], "public");
      return jsonResponse(profiles);
    }
    if (url.pathname === "/rest/v1/kit_codes") {
      assert.equal(init.headers["Accept-Profile"], "public");
      return jsonResponse(activations);
    }
    throw new Error("unexpected request");
  };
  return { calls, fetchImpl };
}

test("environment binds exact project, environment, and distinct named principals", () => {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  assert.equal(configuration.expectedEnvironment, "staging");
  assert.equal(configuration.projectOrigin, `https://${PROJECT_REF}.supabase.co`);
  assert.match(configuration.bindingsHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(configuration.canary, {
    id: CANARY_ID,
    email: CANARY_EMAIL,
  });
  assert.deepEqual(configuration.supportAdmin, {
    id: ADMIN_ID,
    email: ADMIN_EMAIL,
    displayName: ADMIN_NAME,
  });

  for (const [name, value, code] of [
    ["FIRELIGHT_EXPECTED_ENVIRONMENT", "preview", "INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT"],
    ["SUPABASE_PROJECT_REF", `${PROJECT_REF.slice(0, 19)}!`, "INVALID_SUPABASE_PROJECT_REF"],
    ["FIRELIGHT_CANARY_USER_ID", `${CANARY_ID.slice(0, -1)}A`, "INVALID_FIRELIGHT_CANARY_USER_ID"],
    ["FIRELIGHT_CANARY_EMAIL", "Release@auth.firelight.ie", "INVALID_FIRELIGHT_CANARY_EMAIL"],
    ["FIRELIGHT_SUPPORT_ADMIN_DISPLAY_NAME", " Ada Lovelace", "INVALID_FIRELIGHT_SUPPORT_ADMIN_DISPLAY_NAME"],
  ]) {
    assert.throws(
      () => parseReleasePrincipalsEnvironment({ ...environment, [name]: value }),
      assertCode(code),
    );
  }
  assert.throws(
    () => parseReleasePrincipalsEnvironment({
      ...environment,
      FIRELIGHT_SUPPORT_ADMIN_USER_ID: CANARY_ID,
    }),
    assertCode("RELEASE_PRINCIPALS_NOT_DISTINCT"),
  );
  assert.throws(
    () => parseReleasePrincipalsEnvironment({
      ...environment,
      FIRELIGHT_SUPPORT_ADMIN_EMAIL: CANARY_EMAIL,
    }),
    assertCode("RELEASE_PRINCIPALS_NOT_DISTINCT"),
  );
});

test("release URLs stay on the project-derived Auth Admin and PostgREST origins", () => {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  assert.equal(
    buildAuthAdminUserUrl(configuration, CANARY_ID),
    `https://${PROJECT_REF}.supabase.co/auth/v1/admin/users/${CANARY_ID}`,
  );
  const profilesUrl = new URL(buildPrincipalProfilesUrl(configuration));
  assert.equal(profilesUrl.pathname, "/rest/v1/profiles");
  assert.equal(
    profilesUrl.searchParams.get("id"),
    `in.(${CANARY_ID},${ADMIN_ID})`,
  );
  assert.equal(profilesUrl.searchParams.get("limit"), "2");
  const activationUrl = new URL(buildCanaryActivationUrl(configuration));
  assert.equal(activationUrl.pathname, "/rest/v1/kit_codes");
  assert.equal(activationUrl.searchParams.get("claimed_by"), `eq.${CANARY_ID}`);
  assert.equal(activationUrl.searchParams.get("state"), "eq.claimed");
  assert.throws(
    () => buildAuthAdminUserUrl(configuration, "../../attacker"),
    assertCode("INVALID_RELEASE_PRINCIPAL_USER_ID"),
  );
});

test("verification proves confirmed Auth users, learner/admin roles, and code activation", async () => {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  const { calls, fetchImpl } = successfulFetch();
  const result = await verifyReleasePrincipals(configuration, fetchImpl);
  assert.equal(result.bindingsHash, configuration.bindingsHash);
  assert.match(result.releasePrincipalsHash, /^[0-9a-f]{64}$/u);
  assert.equal(calls.length, 4);

  const replayConfiguration = parseReleasePrincipalsEnvironment({
    ...environment,
    FIRELIGHT_EXPECTED_RELEASE_PRINCIPALS_HASH: result.releasePrincipalsHash,
  });
  const replay = await verifyReleasePrincipals(
    replayConfiguration,
    successfulFetch().fetchImpl,
  );
  assert.equal(replay.releasePrincipalsHash, result.releasePrincipalsHash);
  await assert.rejects(
    verifyReleasePrincipals(
      parseReleasePrincipalsEnvironment({
        ...environment,
        FIRELIGHT_EXPECTED_RELEASE_PRINCIPALS_HASH: "f".repeat(64),
      }),
      successfulFetch().fetchImpl,
    ),
    assertCode("RELEASE_PRINCIPALS_EVIDENCE_MISMATCH"),
  );
});

test("grandfathered canary activation is accepted only without an active kit claim", async () => {
  const profiles = profileRows({
    canary: {
      access_source: "grandfathered",
      access_granted_at: ACTIVATED_AT,
    },
  });
  const result = await verifyReleasePrincipals(
    parseReleasePrincipalsEnvironment(environment),
    successfulFetch({ profiles, activations: [] }).fetchImpl,
  );
  assert.match(result.releasePrincipalsHash, /^[0-9a-f]{64}$/u);
  await assert.rejects(
    verifyReleasePrincipals(
      parseReleasePrincipalsEnvironment(environment),
      successfulFetch({ profiles, activations: activationRows() }).fetchImpl,
    ),
    assertCode("CANARY_ACTIVATION_MISMATCH"),
  );
});

test("Auth proof rejects mismatched, unconfirmed, anonymous, banned, and deleted users", () => {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  const cases = [
    [authUser(ADMIN_ID, CANARY_EMAIL), "CANARY_AUTH_IDENTITY_MISMATCH"],
    [authUser(CANARY_ID, "other@auth.firelight.ie"), "CANARY_AUTH_IDENTITY_MISMATCH"],
    [authUser(CANARY_ID, CANARY_EMAIL, { is_anonymous: true }), "CANARY_AUTH_IDENTITY_MISMATCH"],
    [authUser(CANARY_ID, CANARY_EMAIL, { email_confirmed_at: null }), "CANARY_AUTH_NOT_CONFIRMED"],
    [authUser(CANARY_ID, CANARY_EMAIL, { banned_until: "2099-01-01T00:00:00Z" }), "CANARY_AUTH_DISABLED"],
    [authUser(CANARY_ID, CANARY_EMAIL, { deleted_at: "2026-08-02T00:00:00Z" }), "CANARY_AUTH_DISABLED"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => validateAuthPrincipal(value, configuration.canary, "canary"),
      assertCode(code),
    );
  }
  assert.throws(
    () => validateAuthPrincipal(
      authUser(ADMIN_ID, ADMIN_EMAIL, { email_confirmed_at: null }),
      configuration.supportAdmin,
      "supportAdmin",
    ),
    assertCode("SUPPORT_ADMIN_AUTH_NOT_CONFIRMED"),
  );
});

test("profile proof requires one activated learner and the exact named admin", () => {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  const proof = validatePrincipalProfiles(profileRows(), configuration);
  assert.deepEqual(proof, {
    canaryAccessSource: "code",
    canaryAccessGrantedAt: ACTIVATED_AT,
  });
  for (const [rows, code] of [
    [profileRows().slice(0, 1), "RELEASE_PRINCIPAL_PROFILES_MISMATCH"],
    [profileRows({ canary: { role: "admin" } }), "CANARY_PROFILE_NOT_ACTIVATED_LEARNER"],
    [profileRows({ canary: { access_source: null, access_granted_at: null } }), "CANARY_PROFILE_NOT_ACTIVATED_LEARNER"],
    [profileRows({ admin: { role: "learner" } }), "SUPPORT_ADMIN_PROFILE_MISMATCH"],
    [profileRows({ admin: { display_name: "Generic Support" } }), "SUPPORT_ADMIN_PROFILE_MISMATCH"],
  ]) {
    assert.throws(
      () => validatePrincipalProfiles(rows, configuration),
      assertCode(code),
    );
  }
});

test("code activation must be the exact current non-revoked canary claim", () => {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  const profileProof = validatePrincipalProfiles(profileRows(), configuration);
  assert.deepEqual(
    validateCanaryActivation(activationRows(), configuration, profileProof),
    { kind: "code", id: ACTIVATION_ID, claimedAt: ACTIVATED_AT },
  );
  for (const activations of [
    [],
    [...activationRows(), ...activationRows()],
    activationRows({ claimed_by: ADMIN_ID }),
    activationRows({ state: "revoked", revoked_at: "2026-08-02T00:00:00Z" }),
    activationRows({ claimed_at: "2026-08-02T00:00:00Z" }),
  ]) {
    assert.throws(
      () => validateCanaryActivation(
        activations,
        configuration,
        profileProof,
      ),
      assertCode("CANARY_ACTIVATION_MISMATCH"),
    );
  }
});

test("remote failures expose stable redacted access and request codes", async () => {
  const configuration = parseReleasePrincipalsEnvironment(environment);
  await assert.rejects(
    verifyReleasePrincipals(
      configuration,
      async () => jsonResponse({ message: SERVICE_ROLE_KEY }, 403),
    ),
    assertCode("SUPABASE_AUTH_ADMIN_ACCESS_DENIED"),
  );

  let request = 0;
  await assert.rejects(
    verifyReleasePrincipals(configuration, async () => {
      request += 1;
      if (request === 1) return jsonResponse(authUser(CANARY_ID, CANARY_EMAIL));
      if (request === 2) return jsonResponse(authUser(ADMIN_ID, ADMIN_EMAIL));
      return jsonResponse({ message: CANARY_EMAIL }, 403);
    }),
    assertCode("SUPABASE_RELEASE_DATA_ACCESS_DENIED"),
  );
  await assert.rejects(
    verifyReleasePrincipals(
      configuration,
      async () => jsonResponse({ message: "missing" }, 404),
    ),
    assertCode("SUPABASE_RELEASE_AUTH_USER_NOT_FOUND"),
  );
});
