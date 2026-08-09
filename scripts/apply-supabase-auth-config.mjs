import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";
import {
  buildSupabaseAuthConfigUrl,
  loadAuthTemplates,
  parseSupabaseAuthEnvironment,
  verifySupabaseAuthConfig,
} from "./verify-supabase-auth-config.mjs";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const PASSWORD_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789";
const CONFIRMATIONS = {
  staging: "APPLY_STAGING_AUTH_CONFIG",
  production: "APPLY_PRODUCTION_AUTH_CONFIG",
};

function fail(code) {
  throw new CanaryError(code);
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

export function parseApplyAuthEnvironment(environment) {
  const configuration = parseSupabaseAuthEnvironment(environment);
  if (
    environment.FIRELIGHT_AUTH_CONFIG_CONFIRMATION !==
    CONFIRMATIONS[configuration.expectedEnvironment]
  ) {
    fail("AUTH_CONFIG_CONFIRMATION_REQUIRED");
  }
  const smtpPassword = environment.SUPABASE_SMTP_PASSWORD;
  if (
    typeof smtpPassword !== "string" ||
    smtpPassword.length < 16 ||
    smtpPassword.length > 1024 ||
    containsControlCharacter(smtpPassword)
  ) {
    fail("INVALID_SUPABASE_SMTP_PASSWORD");
  }
  return { configuration, smtpPassword };
}

export function buildAuthPatch(configuration, templates, smtpPassword) {
  return {
    disable_signup: false,
    external_anonymous_users_enabled: false,
    external_email_enabled: true,
    external_phone_enabled: false,
    jwt_exp: 3600,
    mailer_allow_unverified_email_sign_ins: false,
    mailer_autoconfirm: false,
    mailer_otp_exp: 3600,
    mailer_otp_length: 6,
    mailer_secure_email_change_enabled: true,
    mailer_subjects_confirmation: "Light your Firelight camp",
    mailer_subjects_recovery: "Reset your Firelight password",
    mailer_templates_confirmation_content: templates.confirmation,
    mailer_templates_recovery_content: templates.recovery,
    password_min_length: 8,
    password_required_characters: PASSWORD_CHARACTERS,
    refresh_token_rotation_enabled: true,
    security_manual_linking_enabled: false,
    security_refresh_token_reuse_interval: 10,
    security_update_password_require_reauthentication: true,
    site_url: configuration.siteUrl,
    smtp_admin_email: configuration.smtpAdminEmail,
    smtp_host: configuration.smtpHost,
    smtp_max_frequency: 60,
    smtp_pass: smtpPassword,
    smtp_port: String(configuration.smtpPort),
    smtp_sender_name: "Firelight",
    smtp_user: configuration.smtpUser,
    uri_allow_list: `${configuration.siteUrl}/auth`,
  };
}

function managementErrorCode(status) {
  if (status === 401 || status === 403) return "SUPABASE_AUTH_CONFIG_WRITE_DENIED";
  if (status === 404) return "SUPABASE_AUTH_CONFIG_NOT_FOUND";
  if (status === 429) return "SUPABASE_AUTH_CONFIG_RATE_LIMITED";
  return "SUPABASE_AUTH_CONFIG_WRITE_FAILED";
}

export async function applySupabaseAuthConfig(
  configuration,
  templates,
  smtpPassword,
  fetchImpl,
) {
  const payload = buildAuthPatch(configuration, templates, smtpPassword);
  const { response } = await fetchBounded(
    fetchImpl,
    buildSupabaseAuthConfigUrl(configuration),
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "firelight-release-auth-config-applier",
      },
      body: JSON.stringify(payload),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, maximumBytes: MAX_RESPONSE_BYTES },
  );
  if (!response.ok) fail(managementErrorCode(response.status));

  // A successful PATCH is not acceptance. Read the hosted configuration back
  // through the independent verifier and bind the resulting non-secret hash.
  return verifySupabaseAuthConfig(configuration, templates, fetchImpl);
}

async function main() {
  const { configuration, smtpPassword } = parseApplyAuthEnvironment(process.env);
  const templates = await loadAuthTemplates();
  const result = await applySupabaseAuthConfig(
    configuration,
    templates,
    smtpPassword,
    globalThis.fetch,
  );
  process.stdout.write(`auth_config_hash=${result.authConfigHash}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Supabase Auth configuration apply failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
