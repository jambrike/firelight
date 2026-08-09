import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  applySupabaseAuthConfig,
  buildAuthPatch,
  parseApplyAuthEnvironment,
} from "./apply-supabase-auth-config.mjs";

/* global Response */

const TOKEN = "supabase-auth-write-token-must-stay-private";
const SMTP_PASSWORD = "smtp-password-must-stay-private";
const baseEnvironment = {
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
  FIRELIGHT_EXPECTED_SMTP_HOST: "smtp.eu.example.net",
  FIRELIGHT_EXPECTED_SMTP_PORT: "587",
  FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL: "no-reply@auth.firelight.ie",
  FIRELIGHT_EXPECTED_SMTP_USER: "firelight-staging",
  FIRELIGHT_AUTH_CONFIG_CONFIRMATION: "APPLY_STAGING_AUTH_CONFIG",
  SUPABASE_ACCESS_TOKEN: TOKEN,
  SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_SMTP_PASSWORD: SMTP_PASSWORD,
};
const templates = {
  confirmation: "<html>confirmation {{ .ConfirmationURL }}</html>\n",
  recovery: "<html>recovery {{ .ConfirmationURL }}</html>\n",
};

function hostedConfig(overrides = {}) {
  return {
    ...buildAuthPatch(
      parseApplyAuthEnvironment(baseEnvironment).configuration,
      templates,
      SMTP_PASSWORD,
    ),
    external_google_enabled: false,
    ...overrides,
  };
}

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.message.includes(SMTP_PASSWORD), false);
    return true;
  };
}

test("apply requires exact environment confirmation and bounded SMTP secret", () => {
  const parsed = parseApplyAuthEnvironment(baseEnvironment);
  assert.equal(parsed.configuration.expectedEnvironment, "staging");
  assert.equal(parsed.smtpPassword, SMTP_PASSWORD);
  for (const [override, code] of [
    [{ FIRELIGHT_AUTH_CONFIG_CONFIRMATION: "APPLY_PRODUCTION_AUTH_CONFIG" }, "AUTH_CONFIG_CONFIRMATION_REQUIRED"],
    [{ FIRELIGHT_AUTH_CONFIG_CONFIRMATION: "" }, "AUTH_CONFIG_CONFIRMATION_REQUIRED"],
    [{ SUPABASE_SMTP_PASSWORD: "short" }, "INVALID_SUPABASE_SMTP_PASSWORD"],
    [{ SUPABASE_SMTP_PASSWORD: `valid-password${String.fromCharCode(10)}` }, "INVALID_SUPABASE_SMTP_PASSWORD"],
  ]) {
    assert.throws(
      () => parseApplyAuthEnvironment({ ...baseEnvironment, ...override }),
      assertCode(code),
    );
  }
});

test("PATCH body is an exact production Auth contract and keeps password out of evidence", () => {
  const { configuration } = parseApplyAuthEnvironment(baseEnvironment);
  const payload = buildAuthPatch(configuration, templates, SMTP_PASSWORD);
  assert.equal(payload.site_url, "https://staging.firelight.ie");
  assert.equal(payload.uri_allow_list, "https://staging.firelight.ie/auth");
  assert.equal(payload.mailer_autoconfirm, false);
  assert.equal(payload.external_anonymous_users_enabled, false);
  assert.equal(payload.smtp_pass, SMTP_PASSWORD);
  assert.equal(payload.smtp_user, "firelight-staging");
  assert.equal(payload.mailer_templates_confirmation_content, templates.confirmation);
  assert.equal(payload.mailer_templates_recovery_content, templates.recovery);
});

test("apply PATCHes once then independently reads and validates hosted state", async () => {
  const { configuration } = parseApplyAuthEnvironment(baseEnvironment);
  const requests = [];
  const result = await applySupabaseAuthConfig(
    configuration,
    templates,
    SMTP_PASSWORD,
    async (input, init) => {
      requests.push({ input: String(input), init });
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (init.method === "PATCH") {
        const payload = JSON.parse(init.body);
        assert.equal(payload.smtp_pass, SMTP_PASSWORD);
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(init.method, "GET");
      return new Response(JSON.stringify(hostedConfig()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  assert.deepEqual(requests.map((request) => request.init.method), ["PATCH", "GET"]);
  assert.match(result.authConfigHash, /^[0-9a-f]{64}$/u);
  assert.equal(result.authConfigHash.includes(SMTP_PASSWORD), false);
});

test("failed PATCH never attempts the readback and exposes only a stable code", async () => {
  const { configuration } = parseApplyAuthEnvironment(baseEnvironment);
  let requests = 0;
  await assert.rejects(
    applySupabaseAuthConfig(
      configuration,
      templates,
      SMTP_PASSWORD,
      async () => {
        requests += 1;
        return new Response(`${TOKEN} ${SMTP_PASSWORD}`, { status: 403 });
      },
    ),
    assertCode("SUPABASE_AUTH_CONFIG_WRITE_DENIED"),
  );
  assert.equal(requests, 1);
});

test("readback drift turns a successful PATCH into a failed release gate", async () => {
  const { configuration } = parseApplyAuthEnvironment(baseEnvironment);
  let requests = 0;
  await assert.rejects(
    applySupabaseAuthConfig(
      configuration,
      templates,
      SMTP_PASSWORD,
      async (_input, init) => {
        requests += 1;
        if (init.method === "PATCH") return new Response("{}", { status: 200 });
        return new Response(JSON.stringify(hostedConfig({ mailer_autoconfirm: true })));
      },
    ),
    assertCode("SUPABASE_AUTH_SECURITY_CONFIG_MISMATCH"),
  );
  assert.equal(requests, 2);
});
