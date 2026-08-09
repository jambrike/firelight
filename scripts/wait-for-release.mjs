import process from "node:process";
import { setTimeout as waitTimer } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  PUBLIC_PROBE_TIMEOUT_MS,
  PublicProbeError,
  parsePublicProbeEnvironment,
  runPublicProbeAttempt,
  safePublicProbeErrorCode,
} from "./public-status-probe.mjs";

export const RELEASE_PROPAGATION_ATTEMPTS = 12;
export const RELEASE_PROPAGATION_DELAY_MS = 10_000;

const BUILD_SHA = /^[0-9a-f]{40}$/u;

function fail(code) {
  throw new PublicProbeError(code);
}

export function parseReleasePropagationEnvironment(environment) {
  const publicConfiguration = parsePublicProbeEnvironment(environment);
  const expectedBuildId = environment.FIRELIGHT_EXPECTED_BUILD_ID;
  if (
    typeof expectedBuildId !== "string" ||
    !BUILD_SHA.test(expectedBuildId)
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_BUILD_ID");
  }
  return Object.freeze({ ...publicConfiguration, expectedBuildId });
}

function wait(milliseconds) {
  return waitTimer(milliseconds);
}

export async function waitForExpectedRelease(
  configuration,
  {
    fetchImpl,
    waitImpl = wait,
    attempts = RELEASE_PROPAGATION_ATTEMPTS,
    delayMs = RELEASE_PROPAGATION_DELAY_MS,
    timeoutMs = PUBLIC_PROBE_TIMEOUT_MS,
  },
) {
  if (typeof fetchImpl !== "function") fail("INVALID_FETCH_IMPLEMENTATION");
  if (typeof waitImpl !== "function") fail("INVALID_WAIT_IMPLEMENTATION");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) {
    fail("INVALID_PROPAGATION_ATTEMPTS");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    fail("INVALID_PROPAGATION_DELAY");
  }

  let finalCode = "RELEASE_PROPAGATION_FAILED";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const buildId = await runPublicProbeAttempt(configuration, {
        fetchImpl,
        timeoutMs,
      });
      if (buildId === configuration.expectedBuildId) return buildId;
      finalCode = "RELEASE_BUILD_NOT_ACTIVE";
    } catch (error) {
      finalCode = safePublicProbeErrorCode(error);
    }

    if (attempt < attempts) await waitImpl(delayMs);
  }

  fail(finalCode);
}

async function main() {
  const configuration = parseReleasePropagationEnvironment(process.env);
  const buildId = await waitForExpectedRelease(configuration, {
    fetchImpl: globalThis.fetch,
  });
  process.stdout.write(
    `Release propagation passed for ${configuration.expectedEnvironment} build ${buildId}.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Release propagation failed [${safePublicProbeErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
