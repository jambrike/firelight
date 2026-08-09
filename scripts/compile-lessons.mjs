import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { createServer } from "vite";

const fqbn = "arduino:avr:nano:cpu=atmega328old";

function runArduinoCli(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn("arduino-cli", arguments_, {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`arduino-cli was interrupted by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

try {
  const versionCode = await runArduinoCli(["version"]);
  if (versionCode !== 0) process.exitCode = versionCode;
} catch (error) {
  const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  if (missing) {
    process.stderr.write(
      "arduino-cli is not installed. Install the pinned CLI/core/Servo supply from " +
      "compiler-service/Dockerfile, then rerun npm run verify:arduino.\n",
    );
    process.exitCode = 2;
  } else {
    throw error;
  }
}

if (!process.exitCode) {
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true },
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "firelight-lessons-"));

  try {
    const { lessonCatalog } = await server.ssrLoadModule(
      "/src/features/lessons/catalog.ts",
    );
    for (const lesson of lessonCatalog) {
      const sketchName = lesson.id.replaceAll("-", "_");
      const sketchDirectory = join(temporaryRoot, sketchName);
      await mkdir(sketchDirectory);
      await writeFile(
        join(sketchDirectory, `${sketchName}.ino`),
        lesson.starterCode,
        { encoding: "utf8", flag: "wx" },
      );
      process.stdout.write(`Compiling ${lesson.title} for ${fqbn}…\n`);
      const code = await runArduinoCli([
        "compile",
        "--fqbn",
        fqbn,
        "--warnings",
        "all",
        sketchDirectory,
      ]);
      if (code !== 0) {
        throw new Error(`${lesson.title} failed Arduino CLI compilation.`);
      }
    }
    process.stdout.write(`Compiled ${lessonCatalog.length} Firelight lesson sketches.\n`);
  } finally {
    await server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
