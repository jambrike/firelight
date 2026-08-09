import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildSupabaseAuthConfigUrl,
  parseSupabaseAuthEnvironment,
  validateSupabaseAuthConfig,
  verifySupabaseAuthConfig,
} from "./verify-supabase-auth-config.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const TOKEN = "supabase-auth-read-token-must-stay-private";
const environment = {
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
  FIRELIGHT_EXPECTED_SMTP_HOST: "smtp.eu.example.net",
  FIRELIGHT_EXPECTED_SMTP_PORT: "587",
  FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL: "no-reply@auth.firelight.ie",
  FIRELIGHT_EXPECTED_SMTP_USER: "firelight-staging",
  SUPABASE_ACCESS_TOKEN: TOKEN,
  SUPABASE_PROJECT_REF: PROJECT_REF,
};
const templates = {
  confirmation: "<html>confirmation {{ .ConfirmationURL }}</html>\n",
  recovery: "<html>recovery {{ .ConfirmationURL }}</html>\n",
};

function authBody(overrides = {}) {
  return {
    site_url: "https://staging.firelight.ie",
    uri_allow_list: "https://staging.firelight.ie/auth",
    disable_signup: false,
    external_email_enabled: true,
    external_anonymous_users_enabled: false,
    external_phone_enabled: false,
    external_google_enabled: false,
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,
    mailer_secure_email_change_enabled: true,
    security_update_password_require_reauthentication: true,
    security_manual_linking_enabled: false,
    refresh_token_rotation_enabled: true,
    security_refresh_token_reuse_interval: 10,
    jwt_exp: 3600,
    password_min_length: 8,
    password_required_characters: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    mailer_otp_exp: 3600,
    mailer_otp_length: 6,
    smtp_host: "smtp.eu.example.net",
    smtp_port: "587",
    smtp_admin_email: "no-reply@auth.firelight.ie",
    smtp_sender_name: "Firelight",
    smtp_user: "firelight-staging",
    smtp_max_frequency: 60,
    mailer_subjects_confirmation: "Light your Firelight camp",
    mailer_subjects_recovery: "Reset your Firelight password",
    mailer_templates_confirmation_content: templates.confirmation,
    mailer_templates_recovery_content: templates.recovery,
    smtp_pass: TOKEN,
    ...overrides,
  };
}

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

test("environment binds exact hosted origin, project, and custom SMTP identity", () => {
  const parsed = parseSupabaseAuthEnvironment(environment);
  assert.equal(parsed.siteUrl, "https://staging.firelight.ie");
  assert.equal(parsed.smtpPort, 587);
  assert.equal(
    parseSupabaseAuthEnvironment({
      ...environment,
      FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL: "no-reply@heronlabs.ie",
    }).smtpAdminEmail,
    "no-reply@heronlabs.ie",
  );
  for (const [override, code] of [
    [{ FIRELIGHT_EXPECTED_ENVIRONMENT: "development" }, "INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT"],
    [{ SUPABASE_PROJECT_REF: "short" }, "INVALID_SUPABASE_PROJECT_REF"],
    [{ FIRELIGHT_EXPECTED_SMTP_HOST: "project.supabase.co" }, "INVALID_FIRELIGHT_EXPECTED_SMTP_HOST"],
    [{ FIRELIGHT_EXPECTED_SMTP_PORT: "25" }, "INVALID_FIRELIGHT_EXPECTED_SMTP_PORT"],
    [{ FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL: "sender@example.net" }, "INVALID_FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL"],
    [{ FIRELIGHT_EXPECTED_SMTP_USER: "" }, "INVALID_FIRELIGHT_EXPECTED_SMTP_USER"],
  ]) {
    assert.throws(
      () => parseSupabaseAuthEnvironment({ ...environment, ...override }),
      assertCode(code),
    );
  }
});

test("validated Auth config produces stable evidence without secret material", () => {
  const configuration = parseSupabaseAuthEnvironment(environment);
  const first = validateSupabaseAuthConfig(authBody(), configuration, templates);
  const second = validateSupabaseAuthConfig(authBody(), configuration, templates);
  assert.match(first.authConfigHash, /^[0-9a-f]{64}$/u);
  assert.equal(first.authConfigHash, second.authConfigHash);
  assert.equal(first.authConfigHash.includes(TOKEN), false);
  assert.deepEqual(
    validateSupabaseAuthConfig(
      authBody(),
      parseSupabaseAuthEnvironment({
        ...environment,
        FIRELIGHT_EXPECTED_AUTH_CONFIG_HASH: first.authConfigHash,
      }),
      templates,
    ),
    first,
  );
  assert.throws(
    () => validateSupabaseAuthConfig(
      authBody(),
      parseSupabaseAuthEnvironment({
        ...environment,
        FIRELIGHT_EXPECTED_AUTH_CONFIG_HASH: "f".repeat(64),
      }),
      templates,
    ),
    assertCode("SUPABASE_AUTH_CONFIG_EVIDENCE_MISMATCH"),
  );
});

test("identity, confirmation, password, session, and redirect drift fail closed", () => {
  const configuration = parseSupabaseAuthEnvironment(environment);
  const cases = [
    ["site_url", "https://firelight.ie"],
    ["uri_allow_list", "https://staging.firelight.ie/**"],
    ["disable_signup", true],
    ["external_email_enabled", false],
    ["external_anonymous_users_enabled", true],
    ["external_phone_enabled", true],
    ["mailer_autoconfirm", true],
    ["mailer_allow_unverified_email_sign_ins", true],
    ["mailer_secure_email_change_enabled", false],
    ["security_update_password_require_reauthentication", false],
    ["security_manual_linking_enabled", true],
    ["refresh_token_rotation_enabled", false],
    ["security_refresh_token_reuse_interval", 11],
    ["jwt_exp", 7200],
    ["password_min_length", 7],
    ["password_required_characters", ""],
    ["mailer_otp_exp", 7200],
    ["mailer_otp_length", 4],
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () => validateSupabaseAuthConfig(
        authBody({ [key]: value }),
        configuration,
        templates,
      ),
      assertCode("SUPABASE_AUTH_SECURITY_CONFIG_MISMATCH"),
    );
  }
});

test("custom SMTP configuration is exact and throttled", () => {
  const configuration = parseSupabaseAuthEnvironment(environment);
  for (const [key, value] of [
    ["smtp_host", "smtp.attacker.example"],
    ["smtp_port", "465"],
    ["smtp_admin_email", "other@auth.firelight.ie"],
    ["smtp_sender_name", "Other"],
    ["smtp_user", ""],
    ["smtp_user", "other-user"],
    ["smtp_max_frequency", 59],
  ]) {
    assert.throws(
      () => validateSupabaseAuthConfig(
        authBody({ [key]: value }),
        configuration,
        templates,
      ),
      assertCode("SUPABASE_AUTH_SMTP_CONFIG_MISMATCH"),
    );
  }
});

test("unexpected external identity providers are rejected", () => {
  const configuration = parseSupabaseAuthEnvironment(environment);
  assert.throws(
    () => validateSupabaseAuthConfig(
      authBody({ external_github_enabled: true }),
      configuration,
      templates,
    ),
    assertCode("SUPABASE_AUTH_EXTERNAL_PROVIDER_ENABLED"),
  );
});

test("repository subjects and exact templates are release artifacts", () => {
  const configuration = parseSupabaseAuthEnvironment(environment);
  for (const [key, value, code] of [
    ["mailer_subjects_confirmation", "Confirm", "SUPABASE_AUTH_CONFIRMATION_SUBJECT_MISMATCH"],
    ["mailer_subjects_recovery", "Recover", "SUPABASE_AUTH_RECOVERY_SUBJECT_MISMATCH"],
    ["mailer_templates_confirmation_content", "changed", "SUPABASE_AUTH_CONFIRMATION_TEMPLATE_MISMATCH"],
    ["mailer_templates_recovery_content", "changed", "SUPABASE_AUTH_RECOVERY_TEMPLATE_MISMATCH"],
  ]) {
    assert.throws(
      () => validateSupabaseAuthConfig(
        authBody({ [key]: value }),
        configuration,
        templates,
      ),
      assertCode(code),
    );
  }
});

test("Management API read is bounded, redirect-failing, and exact-project scoped", async () => {
  const configuration = parseSupabaseAuthEnvironment(environment);
  assert.equal(
    buildSupabaseAuthConfigUrl(configuration),
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`,
  );
  const result = await verifySupabaseAuthConfig(
    configuration,
    templates,
    async (input, init) => {
      assert.equal(String(input), buildSupabaseAuthConfigUrl(configuration));
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return new Response(JSON.stringify(authBody()));
    },
  );
  assert.match(result.authConfigHash, /^[0-9a-f]{64}$/u);

  await assert.rejects(
    verifySupabaseAuthConfig(
      configuration,
      templates,
      async () => new Response(`denied ${TOKEN}`, { status: 403 }),
    ),
    assertCode("SUPABASE_AUTH_CONFIG_ACCESS_DENIED"),
  );
});
