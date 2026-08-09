import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REQUIRED_WORKER_SECRETS } from "./verify-worker-secrets.mjs";
import {
  validateWorkerSecretsPath,
  workerSecretsFromEnvironment,
  writeWorkerSecretsFile,
} from "./write-worker-secrets.mjs";

function protectedEnvironment() {
  return Object.fromEntries(
    REQUIRED_WORKER_SECRETS.map((name, index) => [
      name,
      `private-${String(index).padStart(2, "0")}-value`,
    ]),
  );
}

test("the bootstrap file contains every required binding with owner-only mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "firelight-worker-secrets-"));
  try {
    const target = join(directory, "firelight-worker-bootstrap-secrets.json");
    const environment = protectedEnvironment();
    assert.equal(await writeWorkerSecretsFile(target, environment), 9);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), environment);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(
      writeWorkerSecretsFile(target, environment),
      /EEXIST/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("secret validation is complete and rejects unsafe values", () => {
  const environment = protectedEnvironment();
  assert.deepEqual(Object.keys(workerSecretsFromEnvironment(environment)), [
    ...REQUIRED_WORKER_SECRETS,
  ]);
  for (const invalid of [undefined, "", " trailing ", "line\nbreak"]) {
    assert.throws(
      () =>
        workerSecretsFromEnvironment({
          ...environment,
          KIT_CODE_PEPPER: invalid,
        }),
      /KIT_CODE_PEPPER/u,
    );
  }
  assert.throws(
    () =>
      validateWorkerSecretsPath(
        "relative/firelight-worker-bootstrap-secrets.json",
      ),
    /path is invalid/u,
  );
  assert.throws(
    () => validateWorkerSecretsPath("/tmp/not-the-approved-name.json"),
    /path is invalid/u,
  );
});

test("the command never prints protected values on success or failure", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "firelight-worker-secrets-cli-"),
  );
  try {
    const target = join(directory, "firelight-worker-bootstrap-secrets.json");
    const environment = protectedEnvironment();
    const result = spawnSync(
      process.execPath,
      ["scripts/write-worker-secrets.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...environment,
          FIRELIGHT_WORKER_SECRETS_PATH: target,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}${result.stderr}`;
    for (const value of Object.values(environment)) {
      assert.equal(output.includes(value), false);
    }
    const failure = spawnSync(
      process.execPath,
      ["scripts/write-worker-secrets.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...environment,
          KIT_CODE_PEPPER: "failure-sentinel-value\n",
          FIRELIGHT_WORKER_SECRETS_PATH: join(
            directory,
            "second-firelight-worker-bootstrap-secrets.json",
          ),
        },
      },
    );
    assert.equal(failure.status, 1);
    assert.equal(
      `${failure.stdout}${failure.stderr}`.includes("failure-sentinel"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
