import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  parseLegacyPagesEnvironment,
  verifyLegacyPages,
} from "./verify-legacy-pages.mjs";

/* global Response */

const ACCOUNT_ID = "a".repeat(32);
const ZONE_ID = "b".repeat(32);
const TOKEN = "cloudflare-token-that-must-stay-private";
const DEPLOYMENT_ID = "12345678-1234-1234-1234-123456789abc";
const COMMIT_SHA = "c".repeat(40);
const HTML = "<!doctype html><title>Firelight legacy</title>";
const FAVICON = "<svg><path d=\"M0 0\"/></svg>";
const environment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID: ZONE_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
  FIRELIGHT_EXPECTED_PAGES_DEPLOYMENT_ID: DEPLOYMENT_ID,
  FIRELIGHT_EXPECTED_PAGES_COMMIT_SHA: COMMIT_SHA,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function envelope(result) {
  return { success: true, errors: [], messages: [], result };
}

function project(overrides = {}) {
  return {
    name: "firelight",
    production_branch: "main",
    domains: ["firelight.ie", "firelight-9mz.pages.dev"],
    canonical_deployment: {
      id: DEPLOYMENT_ID,
      project_name: "firelight",
      environment: "production",
      is_skipped: false,
      deployment_trigger: {
        type: "ad_hoc",
        metadata: { branch: "main", commit_hash: COMMIT_SHA },
      },
      latest_stage: { name: "deploy", status: "success" },
      url: "https://12345678.firelight-9mz.pages.dev",
      ...overrides,
    },
  };
}

function domains() {
  return [{
    name: "firelight.ie",
    status: "active",
    zone_tag: ZONE_ID,
    verification_data: { status: "active" },
  }];
}

function htmlResponse(body = HTML) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function successfulFetch({ projectResult = project(), publicAsset = FAVICON } = {}) {
  return async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init.redirect, "error");
    if (url.hostname === "api.cloudflare.com") {
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return new Response(JSON.stringify(envelope(
        url.pathname.endsWith("/domains") ? domains() : projectResult,
      )));
    }
    if (url.pathname === "/favicon.svg") {
      return new Response(
        url.hostname === "firelight.ie" ? publicAsset : FAVICON,
        { headers: { "content-type": "image/svg+xml" } },
      );
    }
    if (url.hostname === "12345678.firelight-9mz.pages.dev") return htmlResponse();
    assert.equal(url.href, "https://firelight.ie/api/config");
    return htmlResponse(`${HTML}<script>dynamic-challenge</script>`);
  };
}

test("legacy Pages environment pins account, zone, deployment, and commit", () => {
  assert.deepEqual(parseLegacyPagesEnvironment(environment), {
    accountId: ACCOUNT_ID,
    zoneId: ZONE_ID,
    apiToken: TOKEN,
    expectedDeploymentId: DEPLOYMENT_ID,
    expectedCommitSha: COMMIT_SHA,
    publicMode: "matched",
  });
  assert.throws(
    () => parseLegacyPagesEnvironment({ ...environment, CLOUDFLARE_ZONE_ID: "wrong" }),
    assertCode("INVALID_CLOUDFLARE_ZONE_ID"),
  );
  assert.throws(
    () => parseLegacyPagesEnvironment({
      ...environment,
      FIRELIGHT_EXPECTED_PAGES_COMMIT_SHA: "D".repeat(40),
    }),
    assertCode("INVALID_FIRELIGHT_EXPECTED_PAGES_COMMIT_SHA"),
  );
});

test("deployment-only mode proves retained Pages without expecting it to own traffic", async () => {
  const configuration = parseLegacyPagesEnvironment({
    ...environment,
    FIRELIGHT_LEGACY_PAGES_PUBLIC_MODE: "deployment-only",
  });
  let publicCalls = 0;
  const result = await verifyLegacyPages(configuration, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "firelight.ie") publicCalls += 1;
    return successfulFetch()(input, init);
  });
  assert.equal(result.publicMode, "deployment-only");
  assert.equal(publicCalls, 0);
});

test("verification binds the live fallback bytes to the exact production deployment", async () => {
  const result = await verifyLegacyPages(
    parseLegacyPagesEnvironment(environment),
    successfulFetch(),
  );
  assert.equal(result.deploymentId, DEPLOYMENT_ID);
  assert.equal(result.commitSha, COMMIT_SHA);
  assert.equal(
    result.legacyAssetHash,
    createHash("sha256").update(FAVICON).digest("hex"),
  );
  assert.match(result.evidenceHash, /^[0-9a-f]{64}$/u);

  const rechecked = await verifyLegacyPages(
    parseLegacyPagesEnvironment({
      ...environment,
      FIRELIGHT_EXPECTED_LEGACY_PAGES_EVIDENCE_HASH: result.evidenceHash,
    }),
    successfulFetch(),
  );
  assert.equal(rechecked.evidenceHash, result.evidenceHash);
});

test("verification rejects a different live body, deployment, or domain zone", async () => {
  const configuration = parseLegacyPagesEnvironment(environment);
  await assert.rejects(
    verifyLegacyPages(configuration, successfulFetch({ publicAsset: "other" })),
    assertCode("LEGACY_PAGES_CONTENT_MISMATCH"),
  );
  await assert.rejects(
    verifyLegacyPages(
      configuration,
      successfulFetch({ projectResult: project({ id: "87654321-4321-4321-4321-cba987654321" }) }),
    ),
    assertCode("LEGACY_PAGES_DEPLOYMENT_MISMATCH"),
  );
  await assert.rejects(
    verifyLegacyPages(configuration, successfulFetch({
      projectResult: {
        ...project(),
        source: { type: "github", config: { owner: "someone" } },
      },
    })),
    assertCode("LEGACY_PAGES_PROJECT_MISMATCH"),
  );
  await assert.rejects(
    verifyLegacyPages(configuration, successfulFetch({
      projectResult: {
        ...project(),
        domains: [
          "firelight.ie",
          "firelight-9mz.pages.dev",
          "firelight-other.pages.dev",
        ],
      },
    })),
    assertCode("LEGACY_PAGES_PROJECT_MISMATCH"),
  );
  await assert.rejects(
    verifyLegacyPages(configuration, async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.cloudflare.com") return htmlResponse();
      return new Response(JSON.stringify(envelope(
        url.pathname.endsWith("/domains")
          ? [{ ...domains()[0], zone_tag: "d".repeat(32) }]
          : project(),
      )), { headers: { "content-type": "application/json" } });
    }),
    assertCode("LEGACY_PAGES_DOMAIN_MISMATCH"),
  );
});

test("verification fails closed on a changed approval evidence hash", async () => {
  const configuration = parseLegacyPagesEnvironment({
    ...environment,
    FIRELIGHT_EXPECTED_LEGACY_PAGES_EVIDENCE_HASH: "f".repeat(64),
  });
  await assert.rejects(
    verifyLegacyPages(configuration, successfulFetch()),
    assertCode("LEGACY_PAGES_EVIDENCE_MISMATCH"),
  );
});
