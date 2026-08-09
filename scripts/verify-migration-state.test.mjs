import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  MIGRATION_HISTORY_EXISTS_QUERY,
  MIGRATION_HISTORY_QUERY,
  buildMigrationQueryUrl,
  migrationStateHash,
  parseMigrationHistory,
  parseMigrationStateEnvironment,
  verifyMigrationState,
} from "./verify-migration-state.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const TOKEN = "supabase-token-that-must-stay-private";
const history = [
  { version: "202608060001", name: "identity_foundation" },
  { version: "202608070001", name: "progress_revision" },
];
const environment = {
  SUPABASE_PROJECT_REF: PROJECT_REF,
  SUPABASE_ACCESS_TOKEN: TOKEN,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

test("migration history is exact, sorted, bounded, and deterministically hashed", () => {
  assert.deepEqual(parseMigrationHistory(history), history);
  assert.equal(migrationStateHash(history), migrationStateHash([...history]));
  for (const invalid of [
    [...history].reverse(),
    [...history, history[1]],
    [{ version: "migration-one", name: "bad" }],
    [{ version: "202608060001", name: "bad\nname" }],
    [{ version: "202608060001", name: "safe", extra: true }],
  ]) {
    assert.throws(
      () => parseMigrationHistory(invalid),
      assertCode("INVALID_MIGRATION_HISTORY"),
    );
  }
});

test("migration evidence input requires the exact preview hash", () => {
  const expectedHash = migrationStateHash(history);
  assert.deepEqual(parseMigrationStateEnvironment({
    ...environment,
    FIRELIGHT_EXPECTED_MIGRATION_STATE_HASH: expectedHash,
  }), {
    projectRef: PROJECT_REF,
    accessToken: TOKEN,
    expectedHash,
    allowMissingHistory: false,
  });
  assert.throws(
    () => parseMigrationStateEnvironment({
      ...environment,
      FIRELIGHT_EXPECTED_MIGRATION_STATE_HASH: "not-a-hash",
    }),
    assertCode("INVALID_FIRELIGHT_EXPECTED_MIGRATION_STATE_HASH"),
  );
  assert.deepEqual(parseMigrationStateEnvironment({
    ...environment,
    FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION: "BOOTSTRAP_PRODUCTION_DATABASE",
  }), {
    projectRef: PROJECT_REF,
    accessToken: TOKEN,
    expectedHash: undefined,
    allowMissingHistory: true,
  });
  assert.throws(
    () => parseMigrationStateEnvironment({
      ...environment,
      FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION: "yes",
    }),
    assertCode("INVALID_FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION"),
  );
});

test("remote history query is read-only, bounded, and project scoped", async () => {
  const configuration = parseMigrationStateEnvironment(environment);
  assert.equal(
    buildMigrationQueryUrl(configuration),
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  );
  const queries = [];
  const result = await verifyMigrationState(configuration, async (input, init) => {
    assert.equal(String(input), buildMigrationQueryUrl(configuration));
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    const request = JSON.parse(init.body);
    queries.push(request);
    assert.equal(request.read_only, true);
    if (request.query === MIGRATION_HISTORY_EXISTS_QUERY) {
      return new Response(JSON.stringify([{ exists: true }]));
    }
    assert.equal(request.query, MIGRATION_HISTORY_QUERY);
    return new Response(JSON.stringify(history));
  });
  assert.deepEqual(queries, [
    { query: MIGRATION_HISTORY_EXISTS_QUERY, read_only: true },
    { query: MIGRATION_HISTORY_QUERY, read_only: true },
  ]);
  assert.deepEqual(result, {
    stateHash: migrationStateHash(history),
    count: history.length,
  });
});

test("a confirmed absent migration table is treated as empty history", async () => {
  const configuration = parseMigrationStateEnvironment({
    ...environment,
    FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION: "BOOTSTRAP_PRODUCTION_DATABASE",
    FIRELIGHT_EXPECTED_MIGRATION_STATE_HASH: migrationStateHash([]),
  });
  let requests = 0;
  const result = await verifyMigrationState(configuration, async (_input, init) => {
    requests += 1;
    assert.deepEqual(JSON.parse(init.body), {
      query: MIGRATION_HISTORY_EXISTS_QUERY,
      read_only: true,
    });
    return new Response(JSON.stringify([{ exists: false }]));
  });
  assert.equal(requests, 1);
  assert.deepEqual(result, {
    stateHash: migrationStateHash([]),
    count: 0,
  });
});

test("a missing migration table fails outside explicit database bootstrap", async () => {
  const configuration = parseMigrationStateEnvironment(environment);
  await assert.rejects(
    verifyMigrationState(
      configuration,
      async () => new Response(JSON.stringify([{ exists: false }])),
    ),
    assertCode("MIGRATION_HISTORY_MISSING"),
  );
});

test("migration-table absence must be explicitly confirmed", async () => {
  const configuration = parseMigrationStateEnvironment(environment);
  for (const invalid of [[], [{ exists: "false" }], [{ missing: false }]]) {
    await assert.rejects(
      verifyMigrationState(
        configuration,
        async () => new Response(JSON.stringify(invalid)),
      ),
      assertCode("INVALID_MIGRATION_HISTORY_EXISTENCE"),
    );
  }
  await assert.rejects(
    verifyMigrationState(
      configuration,
      async () => new Response("unavailable", { status: 500 }),
    ),
    assertCode("SUPABASE_MIGRATION_STATE_UNAVAILABLE"),
  );
});

test("post-approval history drift fails before migration apply", async () => {
  const configuration = parseMigrationStateEnvironment({
    ...environment,
    FIRELIGHT_EXPECTED_MIGRATION_STATE_HASH: migrationStateHash([]),
  });
  await assert.rejects(
    verifyMigrationState(
      configuration,
      async (_input, init) => {
        const { query } = JSON.parse(init.body);
        return new Response(JSON.stringify(
          query === MIGRATION_HISTORY_EXISTS_QUERY ? [{ exists: true }] : history,
        ));
      },
    ),
    assertCode("REMOTE_MIGRATION_STATE_CHANGED"),
  );
});
