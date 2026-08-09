import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const MANAGEMENT_API = "https://api.supabase.com";
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const APPROVED_SMTP_ADMIN_DOMAINS = new Set([
  "auth.firelight.ie",
  "heronlabs.ie",
]);
const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const PASSWORD_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789";
const SUBJECTS = {
  confirmation: "Light your Firelight camp",
  recovery: "Reset your Firelight password",
};
const BASE_URLS = {
  staging: "https://staging.firelight.ie",
  production: "https://firelight.ie",
};

function fail(code) {
  throw new CanaryError(code);
}

function requiredString(environment, name, maximum) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    fail(`INVALID_${name}`);
  }
  return value;
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

export function parseSupabaseAuthEnvironment(environment) {
  const expectedEnvironment = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_ENVIRONMENT",
    10,
  );
  if (!(expectedEnvironment in BASE_URLS)) {
    fail("INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT");
  }
  const projectRef = requiredString(environment, "SUPABASE_PROJECT_REF", 20);
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");
  const accessToken = requiredString(environment, "SUPABASE_ACCESS_TOKEN", 4096);
  if (accessToken.length < 20 || /\s/u.test(accessToken)) {
    fail("INVALID_SUPABASE_ACCESS_TOKEN");
  }
  const smtpHost = requiredString(environment, "FIRELIGHT_EXPECTED_SMTP_HOST", 253);
  if (!HOSTNAME.test(smtpHost) || smtpHost.endsWith(".supabase.co")) {
    fail("INVALID_FIRELIGHT_EXPECTED_SMTP_HOST");
  }
  const smtpPortText = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_SMTP_PORT",
    5,
  );
  if (!/^(465|587)$/u.test(smtpPortText)) {
    fail("INVALID_FIRELIGHT_EXPECTED_SMTP_PORT");
  }
  const smtpAdminEmail = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL",
    320,
  );
  const smtpAdminDomain = smtpAdminEmail.toLowerCase().split("@").at(-1);
  if (
    !EMAIL.test(smtpAdminEmail) ||
    !smtpAdminDomain ||
    !APPROVED_SMTP_ADMIN_DOMAINS.has(smtpAdminDomain)
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL");
  }
  const smtpUser = requiredString(environment, "FIRELIGHT_EXPECTED_SMTP_USER", 320);
  const expectedHash = environment.FIRELIGHT_EXPECTED_AUTH_CONFIG_HASH;
  if (
    expectedHash !== undefined &&
    (typeof expectedHash !== "string" || !LOWERCASE_SHA256.test(expectedHash))
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_AUTH_CONFIG_HASH");
  }
  return {
    accessToken,
    expectedEnvironment,
    expectedHash,
    projectRef,
    siteUrl: BASE_URLS[expectedEnvironment],
    smtpAdminEmail,
    smtpHost,
    smtpPort: Number(smtpPortText),
    smtpUser,
  };
}

export function buildSupabaseAuthConfigUrl(configuration) {
  return `${MANAGEMENT_API}/v1/projects/${configuration.projectRef}/config/auth`;
}

function exactTemplate(value, expected, code) {
  if (typeof value !== "string" || value !== expected) fail(code);
}

function validateDisabledExternalProviders(value) {
  for (const [key, enabled] of Object.entries(value)) {
    if (
      key.startsWith("external_") &&
      key.endsWith("_enabled") &&
      key !== "external_email_enabled" &&
      key !== "external_anonymous_users_enabled" &&
      key !== "external_phone_enabled" &&
      enabled === true
    ) {
      fail("SUPABASE_AUTH_EXTERNAL_PROVIDER_ENABLED");
    }
  }
}

function canonicalHash(configuration, templateHashes) {
  const canonical = JSON.stringify({
    environment: configuration.expectedEnvironment,
    projectRef: configuration.projectRef,
    siteUrl: configuration.siteUrl,
    redirectUrls: [`${configuration.siteUrl}/auth`],
    emailConfirmations: true,
    emailSignup: true,
    anonymousSignup: false,
    jwtExpiry: 3600,
    passwordMinLength: 8,
    passwordRequiredCharacters: PASSWORD_CHARACTERS,
    refreshTokenRotation: true,
    refreshTokenReuseInterval: 10,
    secureEmailChange: true,
    securePasswordChange: true,
    smtpHost: configuration.smtpHost,
    smtpPort: configuration.smtpPort,
    smtpAdminEmail: configuration.smtpAdminEmail,
    smtpSenderName: "Firelight",
    smtpUser: configuration.smtpUser,
    subjects: SUBJECTS,
    templates: templateHashes,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function validateSupabaseAuthConfig(value, configuration, templates) {
  if (!isRecord(value)) fail("SUPABASE_AUTH_CONFIG_INVALID");
  validateDisabledExternalProviders(value);

  const expectedRedirect = `${configuration.siteUrl}/auth`;
  const redirects = typeof value.uri_allow_list === "string"
    ? value.uri_allow_list.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const smtpPort = typeof value.smtp_port === "string"
    ? Number(value.smtp_port)
    : value.smtp_port;
  if (
    value.site_url !== configuration.siteUrl ||
    redirects.length !== 1 ||
    redirects[0] !== expectedRedirect ||
    value.disable_signup !== false ||
    value.external_email_enabled !== true ||
    value.external_anonymous_users_enabled !== false ||
    value.external_phone_enabled !== false ||
    value.mailer_autoconfirm !== false ||
    value.mailer_allow_unverified_email_sign_ins !== false ||
    value.mailer_secure_email_change_enabled !== true ||
    value.security_update_password_require_reauthentication !== true ||
    value.security_manual_linking_enabled !== false ||
    value.refresh_token_rotation_enabled !== true ||
    value.security_refresh_token_reuse_interval !== 10 ||
    value.jwt_exp !== 3600 ||
    value.password_min_length !== 8 ||
    value.password_required_characters !== PASSWORD_CHARACTERS ||
    value.mailer_otp_exp !== 3600 ||
    value.mailer_otp_length !== 6
  ) {
    fail("SUPABASE_AUTH_SECURITY_CONFIG_MISMATCH");
  }
  if (
    value.smtp_host !== configuration.smtpHost ||
    smtpPort !== configuration.smtpPort ||
    value.smtp_admin_email !== configuration.smtpAdminEmail ||
    value.smtp_sender_name !== "Firelight" ||
    value.smtp_user !== configuration.smtpUser ||
    !Number.isSafeInteger(value.smtp_max_frequency) ||
    value.smtp_max_frequency < 60
  ) {
    fail("SUPABASE_AUTH_SMTP_CONFIG_MISMATCH");
  }

  if (value.mailer_subjects_confirmation !== SUBJECTS.confirmation) {
    fail("SUPABASE_AUTH_CONFIRMATION_SUBJECT_MISMATCH");
  }
  if (value.mailer_subjects_recovery !== SUBJECTS.recovery) {
    fail("SUPABASE_AUTH_RECOVERY_SUBJECT_MISMATCH");
  }
  exactTemplate(
    value.mailer_templates_confirmation_content,
    templates.confirmation,
    "SUPABASE_AUTH_CONFIRMATION_TEMPLATE_MISMATCH",
  );
  exactTemplate(
    value.mailer_templates_recovery_content,
    templates.recovery,
    "SUPABASE_AUTH_RECOVERY_TEMPLATE_MISMATCH",
  );

  const templateHashes = {
    confirmation: createHash("sha256").update(templates.confirmation, "utf8").digest("hex"),
    recovery: createHash("sha256").update(templates.recovery, "utf8").digest("hex"),
  };
  const authConfigHash = canonicalHash(configuration, templateHashes);
  if (
    configuration.expectedHash !== undefined &&
    configuration.expectedHash !== authConfigHash
  ) {
    fail("SUPABASE_AUTH_CONFIG_EVIDENCE_MISMATCH");
  }
  return { authConfigHash };
}

function managementErrorCode(status) {
  if (status === 401 || status === 403) return "SUPABASE_AUTH_CONFIG_ACCESS_DENIED";
  if (status === 404) return "SUPABASE_AUTH_CONFIG_NOT_FOUND";
  if (status === 429) return "SUPABASE_AUTH_CONFIG_RATE_LIMITED";
  return "SUPABASE_AUTH_CONFIG_REQUEST_FAILED";
}

export async function verifySupabaseAuthConfig(
  configuration,
  templates,
  fetchImpl,
) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildSupabaseAuthConfigUrl(configuration),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.accessToken}`,
        "User-Agent": "firelight-release-auth-config-verifier",
      },
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, maximumBytes: MAX_RESPONSE_BYTES },
  );
  if (!response.ok) fail(managementErrorCode(response.status));
  return validateSupabaseAuthConfig(parseJsonBytes(bytes), configuration, templates);
}

export async function loadAuthTemplates() {
  const [confirmation, recovery] = await Promise.all([
    readFile(new URL("../supabase/templates/confirmation.html", import.meta.url), "utf8"),
    readFile(new URL("../supabase/templates/recovery.html", import.meta.url), "utf8"),
  ]);
  return { confirmation, recovery };
}

async function main() {
  const configuration = parseSupabaseAuthEnvironment(process.env);
  const templates = await loadAuthTemplates();
  const result = await verifySupabaseAuthConfig(
    configuration,
    templates,
    globalThis.fetch,
  );
  process.stdout.write(`auth_config_hash=${result.authConfigHash}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Supabase Auth configuration verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
