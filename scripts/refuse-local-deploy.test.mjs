import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

test("the local deploy command always fails before invoking a provider", () => {
  const result = spawnSync(process.execPath, ["scripts/refuse-local-deploy.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /protected GitHub Actions workflows/u);
  assert.doesNotMatch(result.stderr, /token|secret|password/iu);
});
