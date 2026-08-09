import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { REQUIRED_WORKER_SECRETS } from "./verify-worker-secrets.mjs";

const EXPECTED_FILENAME = "firelight-worker-bootstrap-secrets.json";
const MAXIMUM_SECRET_LENGTH = 16 * 1024;

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function readSecret(environment, name) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_SECRET_LENGTH ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw new TypeError(`The protected ${name} value is missing or invalid.`);
  }
  return value;
}

export function workerSecretsFromEnvironment(environment) {
  return Object.fromEntries(
    REQUIRED_WORKER_SECRETS.map((name) => [name, readSecret(environment, name)]),
  );
}

export function validateWorkerSecretsPath(filePath) {
  if (
    typeof filePath !== "string" ||
    !isAbsolute(filePath) ||
    resolve(filePath) !== filePath ||
    basename(filePath) !== EXPECTED_FILENAME
  ) {
    throw new TypeError("The Worker bootstrap secret-file path is invalid.");
  }
  return filePath;
}

export async function writeWorkerSecretsFile(filePath, environment) {
  const target = validateWorkerSecretsPath(filePath);
  const secrets = workerSecretsFromEnvironment(environment);
  await writeFile(target, `${JSON.stringify(secrets)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return REQUIRED_WORKER_SECRETS.length;
}

async function main() {
  const count = await writeWorkerSecretsFile(
    process.env.FIRELIGHT_WORKER_SECRETS_PATH,
    process.env,
  );
  process.stdout.write(`Prepared ${String(count)} protected Worker bindings.\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch(() => {
    process.stderr.write("Worker bootstrap secret-file creation failed.\n");
    process.exitCode = 1;
  });
}
