import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const WORKFLOW_ROOT = new URL("../.github/workflows/", import.meta.url);

async function workflow(name) {
  return readFile(new URL(name, WORKFLOW_ROOT), "utf8");
}

function before(source, earlier, later, message) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.notEqual(earlierIndex, -1, `Missing workflow gate: ${earlier}`);
  assert.notEqual(laterIndex, -1, `Missing workflow gate: ${later}`);
  assert.ok(earlierIndex < laterIndex, message);
}

function manualOnly(source) {
  assert.match(source, /on:\n[ ]{2}workflow_dispatch:/u);
  assert.doesNotMatch(source, /\n[ ]{2}(?:push|pull_request|schedule):/u);
}

test("staging release is manual, bootstrapped atomically, and accepted in order", async () => {
  const source = await workflow("deploy-staging.yml");
  const anchors = source.slice(
    source.indexOf("  release-anchors:"),
    source.indexOf("  snapshot-production-project:"),
  );
  const productionSnapshot = source.slice(
    source.indexOf("  snapshot-production-project:"),
    source.indexOf("  bootstrap-worker:"),
  );
  const databaseTarget = source.slice(
    source.indexOf("  database-target:"),
    source.indexOf("  migrate-and-deploy:"),
  );
  const protectedRelease = source.slice(source.indexOf("  migrate-and-deploy:"));
  const stagingBindingWriter = protectedRelease.slice(
    protectedRelease.indexOf("Prepare the protected staging Worker bindings"),
    protectedRelease.indexOf(
      "Recheck the staging Supabase project snapshot immediately before Worker deploy",
    ),
  );
  manualOnly(source);
  assert.match(source, /DEPLOY_STAGING/u);
  assert.match(source, /BOOTSTRAP_STAGING_WORKER/u);
  assert.match(source, /BOOTSTRAP_STAGING_RELEASE_PRINCIPALS/u);
  assert.match(source, /--secrets-file/u);
  assert.match(source, /if: always\(\)/u);
  assert.match(source, /FIRELIGHT_WORKER_TARGET_MODE: bootstrap/u);
  assert.match(source, /FIRELIGHT_WORKER_TARGET_MODE: existing/u);
  assert.match(source, /organization-identity-hash:/u);
  assert.match(source, /project-ref-identity-hash:/u);
  assert.match(source, /verify-release-environment-anchors\.mjs/u);
  assert.match(source, /\.github\/supabase-project-anchors\.json/u);
  assert.doesNotMatch(anchors, /environment:/u);
  assert.match(productionSnapshot, /name: production-preview/u);
  assert.match(productionSnapshot, /FIRELIGHT_EXPECTED_PROJECT_REF_IDENTITY_HASH/u);
  assert.match(productionSnapshot, /FIRELIGHT_PEER_PROJECT_REF_IDENTITY_HASH/u);
  assert.equal(
    (source.match(/node scripts\/verify-supabase-project\.mjs/gu) ?? []).length,
    (source.match(/FIRELIGHT_PEER_PROJECT_REF_IDENTITY_HASH:/gu) ?? []).length,
  );
  assert.match(source, /capture-web-staging-evidence\.mjs/u);
  assert.match(source, /verify-release-environment-anchors\.mjs/u);
  assert.match(source, /snapshot-production-project:/u);
  assert.match(source, /name: production-preview/u);
  assert.match(source, /verify-prospective-worker-bindings\.mjs/u);
  assert.match(source, /compiler-service\/scripts\/probe_deployment\.py/u);
  assert.match(source, /COMPILER_SERVICE_BUILD_ID/u);
  assert.match(source, /FIRELIGHT_SUPABASE_ANCHOR_SET_SHA256/u);
  assert.match(source, /FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256/u);
  assert.match(source, /steps\.web-staging-evidence\.outputs\.artifact_name/u);
  assert.match(source, /Accepted staging web promotion evidence/u);
  assert.doesNotMatch(databaseTarget, /SUPABASE_SERVICE_ROLE_KEY/u);
  assert.doesNotMatch(databaseTarget, /FIRELIGHT_CANARY_PASSWORD/u);
  assert.match(protectedRelease, /SUPABASE_SERVICE_ROLE_KEY/u);
  assert.match(protectedRelease, /FIRELIGHT_CANARY_PASSWORD/u);
  assert.doesNotMatch(stagingBindingWriter, /COMPILER_SERVICE_IMAGE_DIGEST/u);
  before(
    protectedRelease,
    "Prove the prospective staging Worker bindings before migration",
    "Link the staging database",
    "Staging must prove prospective Worker bindings before database mutation.",
  );
  before(
    protectedRelease,
    "Probe the protected staging compiler before migration",
    "Link the staging database",
    "Staging must compile a real fixture before database mutation.",
  );
  before(
    source,
    "Prove the protected production Supabase peer snapshot",
    "Deploy the first staging Worker version and Custom Domain",
    "Staging must prove its canonical production peer before first bootstrap mutation.",
  );
  before(
    source,
    "Prove the protected production Supabase peer snapshot",
    "Link the staging database",
    "Staging must prove its canonical production peer before database mutation.",
  );
  before(
    protectedRelease,
    "Preflight the existing staging Worker target before migration",
    "Apply staging migrations",
    "Staging Worker feasibility must be proven before database mutation.",
  );
  before(
    protectedRelease,
    "Preflight the complete staging runtime secret inventory",
    "Apply staging migrations",
    "Staging runtime bindings must be proven before database mutation.",
  );
  before(
    protectedRelease,
    "Recheck the staging Supabase project snapshot immediately before migration",
    "Link the staging database",
    "Staging must bind the current protected project snapshot before linking.",
  );
  before(
    protectedRelease,
    "Apply staging migrations",
    "Recheck the existing staging Worker target immediately before deploy",
    "The staging Worker target must be rechecked after database acceptance.",
  );
  before(
    source,
    "npx supabase test db --linked",
    "- name: Deploy the staging Worker and assets",
    "Staging database acceptance must precede the routine Worker release.",
  );
  before(
    protectedRelease,
    "Recheck the staging Supabase project snapshot immediately before Worker deploy",
    "Recheck the existing staging Worker target immediately before deploy",
    "Staging must re-prove its protected project before Worker deployment.",
  );
  before(
    protectedRelease,
    "Re-probe the staging compiler immediately before Worker deploy",
    "Deploy the staging Worker and assets",
    "Staging must re-probe the compiler immediately before Worker deployment.",
  );
  before(
    source,
    "node scripts/wait-for-release.mjs",
    "node scripts/postdeploy-canary.mjs",
    "Staging must observe the exact build before canary acceptance.",
  );
});

test("production release proves retained Pages and preserves the overlay cutover", async () => {
  const source = await workflow("deploy-production.yml");
  const anchors = source.slice(
    source.indexOf("  release-anchors:"),
    source.indexOf("  preview-production-migrations:"),
  );
  const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const preview = source.slice(
    source.indexOf("  preview-production-migrations:"),
    source.indexOf("  apply-and-deploy:"),
  );
  const protectedRelease = source.slice(source.indexOf("  apply-and-deploy:"));
  const productionBindingWriter = protectedRelease.slice(
    protectedRelease.indexOf(
      "Prepare and validate the protected production Worker bindings",
    ),
    protectedRelease.indexOf("Preflight the existing runtime secret inventory"),
  );
  manualOnly(source);
  assert.match(source, /CUTOVER_FIRELIGHT_IE_TO_WORKER/u);
  assert.match(source, /BOOTSTRAP_PRODUCTION_RELEASE_PRINCIPALS/u);
  assert.match(source, /staging_run_id:/u);
  assert.match(source, /staging_evidence_sha256:/u);
  assert.match(source, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u);
  assert.match(source, /node scripts\/verify-web-staging-evidence\.mjs/u);
  assert.match(source, /verify-release-environment-anchors\.mjs/u);
  assert.match(source, /verify-prospective-worker-bindings\.mjs/u);
  assert.match(source, /compiler-service\/scripts\/probe_deployment\.py/u);
  assert.match(source, /COMPILER_SERVICE_BUILD_ID/u);
  assert.match(source, /FIRELIGHT_SUPABASE_ANCHOR_SET_SHA256/u);
  assert.match(source, /verify-release-environment-anchors\.mjs/u);
  assert.match(source, /\.github\/supabase-project-anchors\.json/u);
  assert.doesNotMatch(anchors, /environment:/u);
  assert.match(source, /staging_project_ref_identity_hash/u);
  assert.match(source, /FIRELIGHT_PEER_PROJECT_REF_IDENTITY_HASH/u);
  assert.doesNotMatch(source, /FIRELIGHT_PEER_PROJECT_IDENTITY_HASH/u);
  assert.equal(
    (source.match(/node scripts\/verify-supabase-project\.mjs/gu) ?? []).length,
    (source.match(/FIRELIGHT_PEER_PROJECT_REF_IDENTITY_HASH:/gu) ?? []).length,
  );
  assert.match(source, /FIRELIGHT_EXPECTED_ORGANIZATION_IDENTITY_HASH/u);
  assert.match(source, /node scripts\/verify-legacy-pages\.mjs/u);
  assert.doesNotMatch(source, /pages_deployment_id|pages_commit_sha/u);
  assert.match(
    source,
    /FIRELIGHT_EXPECTED_PAGES_DEPLOYMENT_ID: 06b4410d-37ff-4526-ac71-5fc4e65bee91/u,
  );
  assert.match(
    source,
    /FIRELIGHT_EXPECTED_PAGES_COMMIT_SHA: 38e05a32af5e8506e5f4f5d3b516b1f3c405d2c7/u,
  );
  assert.match(
    source,
    /FIRELIGHT_EXPECTED_LEGACY_PAGES_EVIDENCE_HASH: 02b573aae8d9cfa71312a4e968d0e1f0cab049341519cc782128f5a68e989b4e/u,
  );
  assert.match(source, /FIRELIGHT_LEGACY_ASSET_HASH/u);
  assert.match(source, /--secrets-file/u);
  assert.match(wrangler, /"pattern":\s*"firelight\.ie\/\*"/u);
  assert.match(wrangler, /"zone_name":\s*"firelight\.ie"/u);
  assert.doesNotMatch(preview, /SUPABASE_SERVICE_ROLE_KEY/u);
  assert.doesNotMatch(preview, /FIRELIGHT_CANARY_PASSWORD/u);
  assert.match(protectedRelease, /SUPABASE_SERVICE_ROLE_KEY/u);
  assert.match(protectedRelease, /FIRELIGHT_CANARY_PASSWORD/u);
  assert.doesNotMatch(productionBindingWriter, /COMPILER_SERVICE_IMAGE_DIGEST/u);
  before(
    protectedRelease,
    "Prove the prospective production Worker bindings before migration",
    "Link the approved production database",
    "Production must prove prospective Worker bindings before database mutation.",
  );
  before(
    protectedRelease,
    "Probe the protected production compiler before migration",
    "Link the approved production database",
    "Production must compile a real fixture before database mutation.",
  );
  assert.match(
    protectedRelease,
    /Recheck the source-pinned retained production Pages fallback/u,
  );
  assert.doesNotMatch(
    protectedRelease,
    /if: inputs\.database_bootstrap_confirmation == 'BOOTSTRAP_PRODUCTION_DATABASE'\n\s+id: legacy-pages/u,
  );
  assert.match(
    protectedRelease,
    /FIRELIGHT_LEGACY_PAGES_PUBLIC_MODE: \$\{\{ inputs\.database_bootstrap_confirmation == 'BOOTSTRAP_PRODUCTION_DATABASE' && 'matched' \|\| 'deployment-only' \}\}/u,
  );
  before(
    protectedRelease,
    "Preflight the production Worker target is absent for bootstrap",
    "Apply production migrations",
    "Production Worker bootstrap feasibility must be proven before database mutation.",
  );
  before(
    protectedRelease,
    "Preflight the existing runtime secret inventory",
    "Apply production migrations",
    "Production runtime bindings must be proven before database mutation.",
  );
  before(
    preview,
    "Verify the exact staging web evidence hash and identity snapshot",
    "Bind accepted staging evidence to the source-pinned project label",
    "Production must bind accepted evidence to the canonical staging label.",
  );
  before(
    preview,
    "Bind accepted staging evidence to the source-pinned project label",
    "Prove the protected production Supabase project identity",
    "Production must verify immutable, canonically labeled staging evidence before accessing Supabase.",
  );
  before(
    preview,
    "Recheck production Supabase peer isolation immediately before preview link",
    "Link the production database for preview",
    "Production preview must reject a staging-project collision before linking.",
  );
  before(
    protectedRelease,
    "Recheck production Supabase peer isolation immediately before migration",
    "Link the approved production database",
    "Production must re-prove peer isolation before migration.",
  );
  before(
    protectedRelease,
    "Apply production migrations",
    "Recheck the existing production Worker target immediately before deploy",
    "The production Worker target must be rechecked after database acceptance.",
  );
  before(
    source,
    "node scripts/verify-legacy-pages.mjs",
    "node scripts/verify-database-target.mjs",
    "The first production database proof must be bound to retained Pages.",
  );
  before(
    source,
    "npx supabase test db --linked",
    "npx wrangler deploy --env production --strict",
    "Production database acceptance must precede traffic cutover.",
  );
  before(
    protectedRelease,
    "Recheck production Supabase peer isolation immediately before Worker deploy",
    "Recheck the production Worker target is absent immediately before bootstrap",
    "Production must re-prove peer isolation before either Worker deploy path.",
  );
  before(
    protectedRelease,
    "Re-probe the production compiler immediately before Worker deploy",
    "Deploy the approved production Worker and Pages-overlay route",
    "Production must re-probe the compiler immediately before traffic cutover.",
  );
  before(
    source,
    "node scripts/wait-for-release.mjs",
    "node scripts/postdeploy-canary.mjs",
    "Production must observe the exact build before canary acceptance.",
  );
});

test("provider mutations have separate protected manual workflows", async () => {
  const auth = await workflow("configure-supabase-auth.yml");
  const authAnchors = auth.slice(
    auth.indexOf("  release-anchors:"),
    auth.indexOf("  snapshot-staging-project:"),
  );
  const stagingAuthSnapshot = auth.slice(
    auth.indexOf("  snapshot-staging-project:"),
    auth.indexOf("  snapshot-production-project:"),
  );
  const productionAuthSnapshot = auth.slice(
    auth.indexOf("  snapshot-production-project:"),
    auth.indexOf("  apply:"),
  );
  const restore = await workflow("restore-production-pages.yml");
  const rollback = await workflow("rollback-worker.yml");
  manualOnly(auth);
  manualOnly(restore);
  manualOnly(rollback);
  assert.match(auth, /staging-auth-config/u);
  assert.match(auth, /production-auth-config/u);
  assert.match(auth, /APPLY_\$\{AUTH_ENVIRONMENT\^\^\}_AUTH_CONFIG/u);
  assert.match(auth, /node scripts\/verify-supabase-project\.mjs/u);
  assert.match(auth, /node scripts\/apply-supabase-auth-config\.mjs/u);
  assert.match(auth, /snapshot-staging-project:/u);
  assert.match(auth, /snapshot-production-project:/u);
  assert.match(auth, /verify-release-environment-anchors\.mjs/u);
  assert.doesNotMatch(authAnchors, /environment:/u);
  assert.match(stagingAuthSnapshot, /name: staging-auth-config/u);
  assert.match(productionAuthSnapshot, /name: production-auth-config/u);
  assert.doesNotMatch(stagingAuthSnapshot, /apply-supabase-auth-config/u);
  assert.doesNotMatch(productionAuthSnapshot, /apply-supabase-auth-config/u);
  assert.match(auth, /needs:\n\s+- authorize\n\s+- release-anchors\n\s+- snapshot-staging-project\n\s+- snapshot-production-project/u);
  assert.match(auth, /FIRELIGHT_EXPECTED_PROJECT_REF_IDENTITY_HASH/u);
  assert.match(auth, /FIRELIGHT_PEER_PROJECT_REF_IDENTITY_HASH/u);
  assert.match(auth, /STAGING_ORGANIZATION_IDENTITY_HASH/u);
  assert.match(auth, /PRODUCTION_ORGANIZATION_IDENTITY_HASH/u);
  assert.match(auth, /STAGING_PROJECT_REF_IDENTITY_HASH/u);
  assert.match(auth, /PRODUCTION_PROJECT_REF_IDENTITY_HASH/u);
  assert.equal(
    (auth.match(/node scripts\/verify-supabase-project\.mjs/gu) ?? []).length,
    (auth.match(/FIRELIGHT_PEER_PROJECT_REF_IDENTITY_HASH:/gu) ?? []).length,
  );
  assert.match(auth, /FIRELIGHT_EXPECTED_SMTP_USER/u);
  assert.match(auth, /group: deploy-\$\{\{ inputs\.environment \}\}/u);
  assert.match(auth, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(auth, /dispatch a fresh run/u);
  before(
    auth,
    "Require same-organization distinct-project Auth snapshots",
    "Recheck the selected protected Supabase project immediately before changing Auth",
    "Auth mutation must first prove the two protected environments are isolated.",
  );
  before(
    auth,
    "Recheck the selected protected Supabase project immediately before changing Auth",
    "Apply and read back the exact hosted Auth configuration",
    "Auth must re-prove the selected snapshot and peer isolation immediately before mutation.",
  );
  assert.match(restore, /RESTORE_FIRELIGHT_IE_PAGES/u);
  assert.match(restore, /environment:\n\s+name: production/u);
  assert.doesNotMatch(restore, /pages_deployment_id|pages_commit_sha/u);
  assert.match(restore, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(
    restore,
    /FIRELIGHT_EXPECTED_PAGES_DEPLOYMENT_ID: 06b4410d-37ff-4526-ac71-5fc4e65bee91/u,
  );
  assert.match(
    restore,
    /FIRELIGHT_EXPECTED_LEGACY_PAGES_EVIDENCE_HASH: 02b573aae8d9cfa71312a4e968d0e1f0cab049341519cc782128f5a68e989b4e/u,
  );
  before(
    restore,
    "FIRELIGHT_LEGACY_PAGES_PUBLIC_MODE: deployment-only",
    "node scripts/restore-production-pages.mjs",
    "Retained Pages must be proven before the route is removed.",
  );
  before(
    restore,
    "node scripts/restore-production-pages.mjs",
    "FIRELIGHT_LEGACY_PAGES_PUBLIC_MODE: matched",
    "The restore must prove Pages owns traffic after route removal.",
  );
  assert.match(rollback, /Require an explicit rollback from main/u);
  assert.match(rollback, /needs: authorize/u);
  assert.match(rollback, /ref: \$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(rollback, /ref: main/u);
  assert.match(
    rollback,
    /release_run_id:\n\s+description: Exact successful release workflow run that accepted this Worker version\n\s+required: true/u,
  );
  assert.match(
    rollback,
    /FIRELIGHT_RELEASE_RUN_ID: \$\{\{ inputs\.release_run_id \}\}/u,
  );
  assert.match(
    rollback,
    /run-id: \$\{\{ steps\.accepted-release\.outputs\.release_run_id \}\}/u,
  );
  before(
    rollback,
    "Bind the rollback implementation to its dispatched commit",
    "Check out current main for rollback ancestry proof",
    "Rollback must bind its exact approved implementation before resolving current main.",
  );
  before(
    rollback,
    "Require a valid release commit already present on current main",
    "npm ci",
    "Rollback ancestry must be proven before dependencies run.",
  );
  assert.match(
    rollback,
    /ref: refs\/heads\/main\n\s+path: rollback-main\n\s+persist-credentials: false/u,
  );
  assert.match(rollback, /ROLLBACK_MAIN_SHA: \$\{\{ steps\.rollback-main\.outputs\.commit \}\}/u);
  assert.match(rollback, /git merge-base --is-ancestor "\$EXPECTED_BUILD_ID" "\$ROLLBACK_MAIN_SHA"/u);
  assert.doesNotMatch(rollback, /git fetch/u);
});

test("rollback proves current compiler and Supabase compatibility before traffic", async () => {
  const source = await workflow("rollback-worker.yml");
  const artifactVerification = source.slice(
    source.indexOf("Bind the requested version to accepted release evidence"),
    source.indexOf("Verify the requested version in the exact Worker inventory"),
  );
  const compilerProbe = source.slice(
    source.indexOf("Probe the current compatible compiler before rollback traffic changes"),
    source.indexOf("Recheck the protected Supabase target immediately before rollback"),
  );
  const supabaseRecheck = source.slice(
    source.indexOf("Recheck the protected Supabase target immediately before rollback"),
    source.indexOf("Roll back to the verified Worker version"),
  );

  assert.match(source, /verify-release-environment-anchors\.mjs/u);
  assert.match(source, /\.github\/supabase-project-anchors\.json/u);
  assert.match(artifactVerification, /FIRELIGHT_SUPABASE_ANCHOR_SET_SHA256/u);
  assert.match(
    artifactVerification,
    /FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256/u,
  );
  assert.match(
    artifactVerification,
    /FIRELIGHT_SUPABASE_ORGANIZATION_IDENTITY_SHA256/u,
  );
  assert.match(artifactVerification, /COMPILER_SERVICE_URL/u);
  assert.match(artifactVerification, /COMPILER_SERVICE_ORIGIN/u);
  assert.match(artifactVerification, /COMPILER_SERVICE_HOST/u);
  assert.match(artifactVerification, /COMPILER_SERVICE_TOKEN/u);
  assert.doesNotMatch(artifactVerification, /COMPILER_SERVICE_BUILD_ID/u);
  assert.doesNotMatch(artifactVerification, /COMPILER_SERVICE_IMAGE_DIGEST/u);

  assert.match(compilerProbe, /compiler-service\/scripts\/probe_deployment\.py/u);
  assert.match(compilerProbe, /FIRELIGHT_COMPILER_ENVIRONMENT/u);
  assert.match(
    compilerProbe,
    /FIRELIGHT_COMPILER_RELEASE_BUILD_ID: \$\{\{ secrets\.COMPILER_SERVICE_BUILD_ID \}\}/u,
  );
  assert.match(
    compilerProbe,
    /FIRELIGHT_COMPILER_IMAGE_DIGEST: \$\{\{ secrets\.COMPILER_SERVICE_IMAGE_DIGEST \}\}/u,
  );
  assert.match(
    supabaseRecheck,
    /FIRELIGHT_EXPECTED_PROJECT_IDENTITY_HASH: \$\{\{ steps\.current-project\.outputs\.project_identity_hash \}\}/u,
  );
  assert.match(supabaseRecheck, /FIRELIGHT_EXPECTED_PROJECT_REF_IDENTITY_HASH/u);
  assert.match(supabaseRecheck, /FIRELIGHT_EXPECTED_ORGANIZATION_IDENTITY_HASH/u);
  assert.match(supabaseRecheck, /FIRELIGHT_PEER_PROJECT_REF_IDENTITY_HASH/u);

  before(
    source,
    "Load the source-pinned Supabase environment anchors",
    "Bind the requested version to accepted release evidence",
    "Rollback evidence must use the reviewed logical Supabase anchors.",
  );
  before(
    source,
    "Bind the requested version to accepted release evidence",
    "Probe the current compatible compiler before rollback traffic changes",
    "Rollback must reject changed compiler connection/protocol evidence before probing.",
  );
  before(
    source,
    "Probe the current compatible compiler before rollback traffic changes",
    "Roll back to the verified Worker version",
    "Rollback must prove the live compiler before changing traffic.",
  );
  before(
    source,
    "Recheck the protected Supabase target immediately before rollback",
    "Roll back to the verified Worker version",
    "Rollback must re-prove its logical database target immediately before traffic changes.",
  );

  for (const line of source.split("\n").filter((value) => value.includes("secrets."))) {
    assert.match(
      line,
      /^\s+[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}\s*$/u,
      "Rollback secrets must enter commands only through a step environment.",
    );
  }
});
