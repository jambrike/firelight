import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  parseProspectiveWorkerBindings,
  verifyProspectiveWorkerBindings,
} from "./verify-prospective-worker-bindings.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const PUBLISHABLE_KEY = "publishable-key-that-must-remain-private";
const SERVICE_ROLE_KEY = "service-role-key-that-must-remain-private";
const KIT_CODE_PEPPER = "kit-code-pepper-with-at-least-thirty-two-characters";
const baseEnvironment = {
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
  SUPABASE_PROJECT_REF: PROJECT_REF,
  SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
  SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  KIT_CODE_PEPPER,
};

function assertCode(code) {
  return (error) => error instanceof CanaryError && error.code === code;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("prospective bindings require the exact hosted project and strong values", () => {
  const parsed = parseProspectiveWorkerBindings(baseEnvironment);
  assert.equal(parsed.projectOrigin, `https://${PROJECT_REF}.supabase.co`);
  for (const [name, value, code] of [
    ["SUPABASE_URL", "https://other-project.supabase.co", "SUPABASE_PROJECT_MISMATCH"],
    ["SUPABASE_PUBLISHABLE_KEY", "short", "INVALID_SUPABASE_PUBLISHABLE_KEY"],
    ["SUPABASE_SERVICE_ROLE_KEY", "short", "INVALID_SUPABASE_SERVICE_ROLE_KEY"],
    ["KIT_CODE_PEPPER", "too-short", "INVALID_KIT_CODE_PEPPER"],
  ]) {
    assert.throws(
      () =>
        parseProspectiveWorkerBindings({
          ...baseEnvironment,
          [name]: value,
        }),
      assertCode(code),
    );
  }
});

test("publishable and service-role credentials are proven with bounded reads", async () => {
  const configuration = parseProspectiveWorkerBindings(baseEnvironment);
  const calls = [];
  const result = await verifyProspectiveWorkerBindings(
    configuration,
    async (input, init) => {
      calls.push({ url: String(input), headers: init.headers });
      if (String(input).endsWith("/auth/v1/settings")) {
        assert.equal(init.headers.apikey, PUBLISHABLE_KEY);
        assert.equal("Authorization" in init.headers, false);
        return json({ external: {} });
      }
      assert.equal(init.headers.apikey, SERVICE_ROLE_KEY);
      assert.equal(init.headers.Authorization, `Bearer ${SERVICE_ROLE_KEY}`);
      return json({ users: [] });
    },
  );
  assert.deepEqual(result, { environment: "staging", projectRef: PROJECT_REF });
  assert.equal(calls.length, 2);
});

test("credential failures expose only stable redacted codes", async () => {
  const configuration = parseProspectiveWorkerBindings(baseEnvironment);
  await assert.rejects(
    verifyProspectiveWorkerBindings(configuration, async () =>
      json({ message: PUBLISHABLE_KEY }, 401)),
    assertCode("SUPABASE_PUBLISHABLE_KEY_REJECTED"),
  );
  let call = 0;
  await assert.rejects(
    verifyProspectiveWorkerBindings(configuration, async () => {
      call += 1;
      return call === 1
        ? json({ external: {} })
        : json({ message: SERVICE_ROLE_KEY }, 403);
    }),
    assertCode("SUPABASE_SERVICE_ROLE_KEY_REJECTED"),
  );
});
