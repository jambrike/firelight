import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  bootstrapReleasePrincipals,
  buildSupportAdminPromotionUrl,
  parseReleasePrincipalsBootstrapEnvironment,
  validateBootstrapProfiles,
  validatePromotedSupportProfile,
} from "./bootstrap-release-principals.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const SERVICE_ROLE_KEY = "service-role-bootstrap-value-that-must-stay-private";
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
  FIRELIGHT_RELEASE_PRINCIPALS_BOOTSTRAP_CONFIRMATION:
    "BOOTSTRAP_STAGING_RELEASE_PRINCIPALS",
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

function profiles(state, overrides = {}) {
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
      display_name: state.displayName,
      role: state.role,
      access_source: "grandfathered",
      access_granted_at: ACTIVATED_AT,
      ...overrides.supportAdmin,
    },
  ];
}

function activation() {
  return [{
    id: ACTIVATION_ID,
    kind: "code",
    state: "claimed",
    claimed_by: CANARY_ID,
    claimed_at: ACTIVATED_AT,
    revoked_at: null,
  }];
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function statefulFetch(initial = {}) {
  const state = {
    role: initial.role ?? "learner",
    displayName: initial.displayName ?? "Builder",
  };
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(url.origin, `https://${PROJECT_REF}.supabase.co`);
    assert.equal(init.headers.apikey, SERVICE_ROLE_KEY);
    assert.equal(init.headers.Authorization, `Bearer ${SERVICE_ROLE_KEY}`);
    assert.equal(init.redirect, "error");

    if (url.pathname === `/auth/v1/admin/users/${CANARY_ID}`) {
      assert.equal(init.method, "GET");
      return jsonResponse(authUser(CANARY_ID, CANARY_EMAIL));
    }
    if (url.pathname === `/auth/v1/admin/users/${ADMIN_ID}`) {
      assert.equal(init.method, "GET");
      return jsonResponse(authUser(ADMIN_ID, ADMIN_EMAIL));
    }
    if (url.pathname === "/rest/v1/kit_codes") {
      assert.equal(init.method, "GET");
      return jsonResponse(activation());
    }
    if (url.pathname === "/rest/v1/profiles" && init.method === "GET") {
      return jsonResponse(profiles(state));
    }
    if (url.pathname === "/rest/v1/profiles" && init.method === "PATCH") {
      assert.equal(url.searchParams.get("id"), `eq.${ADMIN_ID}`);
      assert.equal(url.searchParams.get("role"), "eq.learner");
      assert.equal(url.searchParams.get("access_source"), "eq.grandfathered");
      assert.equal(init.headers["Content-Profile"], "public");
      assert.equal(init.headers.Prefer, "return=representation,handling=strict");
      assert.deepEqual(JSON.parse(init.body), {
        role: "admin",
        display_name: ADMIN_NAME,
      });
      if (initial.patchResponse !== undefined) {
        return jsonResponse(initial.patchResponse, initial.patchStatus ?? 200);
      }
      assert.equal(state.role, "learner");
      state.role = "admin";
      state.displayName = ADMIN_NAME;
      return jsonResponse([profiles(state)[1]]);
    }
    throw new Error(`unexpected request ${init.method} ${url.pathname}`);
  };
  return { calls, fetchImpl, state };
}

test("bootstrap requires the exact environment-specific one-time confirmation", () => {
  const staging = parseReleasePrincipalsBootstrapEnvironment(environment);
  assert.equal(staging.expectedEnvironment, "staging");
  for (const confirmation of [
    undefined,
    "BOOTSTRAP_PRODUCTION_RELEASE_PRINCIPALS",
    "BOOTSTRAP_STAGING_RELEASE_PRINCIPALS ",
  ]) {
    assert.throws(
      () => parseReleasePrincipalsBootstrapEnvironment({
        ...environment,
        FIRELIGHT_RELEASE_PRINCIPALS_BOOTSTRAP_CONFIRMATION: confirmation,
      }),
      assertCode("RELEASE_PRINCIPALS_BOOTSTRAP_CONFIRMATION_MISMATCH"),
    );
  }
  const production = parseReleasePrincipalsBootstrapEnvironment({
    ...environment,
    FIRELIGHT_EXPECTED_ENVIRONMENT: "production",
    FIRELIGHT_RELEASE_PRINCIPALS_BOOTSTRAP_CONFIRMATION:
      "BOOTSTRAP_PRODUCTION_RELEASE_PRINCIPALS",
  });
  assert.equal(production.expectedEnvironment, "production");
});

test("promotion URL is a compare-and-set for one exact grandfathered learner", () => {
  const configuration = parseReleasePrincipalsBootstrapEnvironment(environment);
  const url = new URL(buildSupportAdminPromotionUrl(configuration));
  assert.equal(url.origin, `https://${PROJECT_REF}.supabase.co`);
  assert.equal(url.pathname, "/rest/v1/profiles");
  assert.equal(url.searchParams.get("id"), `eq.${ADMIN_ID}`);
  assert.equal(url.searchParams.get("role"), "eq.learner");
  assert.equal(url.searchParams.get("access_source"), "eq.grandfathered");
});

test("bootstrap promotes only the bound support profile and fully verifies readback", async () => {
  const configuration = parseReleasePrincipalsBootstrapEnvironment(environment);
  const remote = statefulFetch();
  const result = await bootstrapReleasePrincipals(configuration, remote.fetchImpl);
  assert.equal(result.promoted, true);
  assert.equal(remote.state.role, "admin");
  assert.equal(remote.state.displayName, ADMIN_NAME);
  assert.match(result.releasePrincipalsHash, /^[0-9a-f]{64}$/u);
  assert.match(result.bindingsHash, /^[0-9a-f]{64}$/u);
  const mutations = remote.calls.filter((call) => call.init.method !== "GET");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].init.method, "PATCH");
  assert.equal(remote.calls.length, 9);
});

test("bootstrap is idempotent when the exact named support admin already exists", async () => {
  const configuration = parseReleasePrincipalsBootstrapEnvironment(environment);
  const remote = statefulFetch({ role: "admin", displayName: ADMIN_NAME });
  const result = await bootstrapReleasePrincipals(configuration, remote.fetchImpl);
  assert.equal(result.promoted, false);
  assert.match(result.releasePrincipalsHash, /^[0-9a-f]{64}$/u);
  assert.equal(
    remote.calls.filter((call) => call.init.method !== "GET").length,
    0,
  );
  assert.equal(remote.calls.length, 8);
});

test("unsafe canary or support prestates fail before any mutation", () => {
  const configuration = parseReleasePrincipalsBootstrapEnvironment(environment);
  const validState = { role: "learner", displayName: "Builder" };
  for (const [rows, code] of [
    [profiles(validState).slice(0, 1), "RELEASE_PRINCIPALS_BOOTSTRAP_PROFILE_MISMATCH"],
    [profiles(validState, { canary: { role: "admin" } }), "CANARY_BOOTSTRAP_PRESTATE_UNSAFE"],
    [profiles(validState, { canary: { access_source: null, access_granted_at: null } }), "CANARY_BOOTSTRAP_PRESTATE_UNSAFE"],
    [profiles(validState, { supportAdmin: { access_source: "code" } }), "SUPPORT_ADMIN_BOOTSTRAP_PRESTATE_UNSAFE"],
    [profiles({ role: "admin", displayName: "Wrong Name" }), "SUPPORT_ADMIN_BOOTSTRAP_PRESTATE_UNSAFE"],
    [profiles({ role: "learner", displayName: " Builder" }), "SUPPORT_ADMIN_BOOTSTRAP_PRESTATE_UNSAFE"],
  ]) {
    assert.throws(
      () => validateBootstrapProfiles(rows, configuration),
      assertCode(code),
    );
  }
});

test("promotion response must prove the exact row and preserve activation state", () => {
  const configuration = parseReleasePrincipalsBootstrapEnvironment(environment);
  const prestate = validateBootstrapProfiles(
    profiles({ role: "learner", displayName: "Builder" }),
    configuration,
  );
  assert.deepEqual(
    validatePromotedSupportProfile(
      [profiles({ role: "admin", displayName: ADMIN_NAME })[1]],
      configuration,
      prestate,
    ),
    { id: ADMIN_ID },
  );
  for (const response of [
    [],
    [profiles({ role: "learner", displayName: ADMIN_NAME })[1]],
    [profiles({ role: "admin", displayName: "Wrong Name" })[1]],
    [profiles({ role: "admin", displayName: ADMIN_NAME }, {
      supportAdmin: { access_granted_at: "2026-08-02T00:00:00.000Z" },
    })[1]],
  ]) {
    assert.throws(
      () => validatePromotedSupportProfile(response, configuration, prestate),
      assertCode(
        response.length === 0
          ? "SUPPORT_ADMIN_PROMOTION_CONFLICT"
          : "SUPPORT_ADMIN_PROMOTION_RESPONSE_MISMATCH",
      ),
    );
  }
});

test("compare-and-set conflicts and access failures expose only stable codes", async () => {
  const configuration = parseReleasePrincipalsBootstrapEnvironment(environment);
  await assert.rejects(
    bootstrapReleasePrincipals(
      configuration,
      statefulFetch({ patchResponse: [] }).fetchImpl,
    ),
    assertCode("SUPPORT_ADMIN_PROMOTION_CONFLICT"),
  );
  await assert.rejects(
    bootstrapReleasePrincipals(
      configuration,
      async () => jsonResponse({ message: SERVICE_ROLE_KEY }, 403),
    ),
    assertCode("SUPABASE_RELEASE_PRINCIPALS_BOOTSTRAP_ACCESS_DENIED"),
  );
});
