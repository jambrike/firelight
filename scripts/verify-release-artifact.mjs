import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { safeCanaryErrorCode } from "./postdeploy-canary.mjs";
import {
  parseReleaseEvidenceEnvironment,
  validateReleaseEvidence,
} from "./release-evidence.mjs";

async function main() {
  const configuration = parseReleaseEvidenceEnvironment(process.env, {
    requirePath: true,
    requireApiToken: false,
  });
  const source = await readFile(configuration.evidencePath, "utf8");
  if (source.length > 16 * 1024) throw new TypeError("Release evidence is too large.");
  const evidence = validateReleaseEvidence(JSON.parse(source), configuration);
  const expectedVersionId = process.env.ROLLBACK_VERSION_ID;
  if (evidence.versionId !== expectedVersionId) {
    throw new TypeError("Release evidence does not match the requested Worker version.");
  }
  process.stdout.write(
    `Verified accepted ${evidence.environment} release ${evidence.buildId}.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Release-evidence verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
