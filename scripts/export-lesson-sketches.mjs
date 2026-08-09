import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { createServer } from "vite";

export const LESSON_FIXTURE_SCHEMA = "firelight.lesson-sketches";
export const LESSON_FIXTURE_VERSION = 1;
export const FIRELIGHT_BOARD_FQBN = "arduino:avr:nano:cpu=atmega328old";
export const PINNED_TOOLCHAIN = Object.freeze({
  arduinoCli: "1.5.1",
  arduinoAvrCore: "1.8.6",
  servo: "1.3.0",
});
export const EXPECTED_LESSON_IDS = Object.freeze([
  "first-spark",
  "morse-name",
  "button-reaction",
  "distance-scout",
  "servo-gate",
  "trail-rover",
]);

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SOURCE_LIMIT_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

export class SketchExportError extends Error {
  constructor(code) {
    super(code);
    this.name = "SketchExportError";
    this.code = code;
  }
}

function fail(code) {
  throw new SketchExportError(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateOutputPath(outputDirectory) {
  if (
    typeof outputDirectory !== "string" ||
    outputDirectory.length === 0 ||
    outputDirectory.length > 4096 ||
    outputDirectory.includes("\0") ||
    !isAbsolute(outputDirectory) ||
    resolve(outputDirectory) !== outputDirectory
  ) {
    fail("INVALID_OUTPUT_DIRECTORY");
  }
  return outputDirectory;
}

export function buildLessonFixture(catalog) {
  if (!Array.isArray(catalog) || catalog.length !== EXPECTED_LESSON_IDS.length) {
    fail("LESSON_COUNT_MISMATCH");
  }

  const sketches = catalog.map((lesson, index) => {
    const expectedId = EXPECTED_LESSON_IDS[index];
    if (
      typeof lesson !== "object" ||
      lesson === null ||
      lesson.id !== expectedId ||
      lesson.order !== index + 1 ||
      !Number.isSafeInteger(lesson.version) ||
      lesson.version < 1 ||
      typeof lesson.starterCode !== "string" ||
      lesson.starterCode.length === 0 ||
      lesson.starterCode.includes("\0") ||
      lesson.starterCode.includes("\r")
    ) {
      fail("LESSON_CATALOG_MISMATCH");
    }
    const source = Buffer.from(lesson.starterCode, "utf8");
    if (source.byteLength > SOURCE_LIMIT_BYTES) fail("LESSON_SOURCE_TOO_LARGE");
    const sketchName = expectedId.replaceAll("-", "_");
    const sourceSha256 = sha256(source);
    if (!SHA256.test(sourceSha256)) fail("LESSON_HASH_INVALID");
    return {
      manifest: {
        id: expectedId,
        version: lesson.version,
        relativePath: `${sketchName}/${sketchName}.ino`,
        sourceSha256,
      },
      source,
    };
  });

  return {
    manifest: {
      schema: LESSON_FIXTURE_SCHEMA,
      version: LESSON_FIXTURE_VERSION,
      fqbn: FIRELIGHT_BOARD_FQBN,
      toolchain: { ...PINNED_TOOLCHAIN },
      count: sketches.length,
      sketches: sketches.map((entry) => entry.manifest),
    },
    sources: sketches,
  };
}

export async function loadTypedLessonCatalog(repositoryRoot = REPOSITORY_ROOT) {
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule("/src/features/lessons/catalog.ts");
    if (!Array.isArray(module.lessonCatalog)) fail("LESSON_CATALOG_MISMATCH");
    return module.lessonCatalog;
  } finally {
    await server.close();
  }
}

export async function exportLessonSketches(
  outputDirectory,
  { loadCatalogImpl = loadTypedLessonCatalog } = {},
) {
  const output = validateOutputPath(outputDirectory);
  if (typeof loadCatalogImpl !== "function") fail("INVALID_CATALOG_LOADER");

  try {
    await stat(output);
    fail("OUTPUT_DIRECTORY_EXISTS");
  } catch (error) {
    if (error instanceof SketchExportError) throw error;
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      fail("OUTPUT_DIRECTORY_UNAVAILABLE");
    }
  }

  const fixture = buildLessonFixture(await loadCatalogImpl());
  let created = false;
  try {
    await mkdir(output, { mode: 0o755 });
    created = true;
    for (const entry of fixture.sources) {
      const sketchDirectory = join(output, entry.manifest.relativePath.split("/")[0]);
      await mkdir(sketchDirectory, { mode: 0o755 });
      await writeFile(join(output, entry.manifest.relativePath), entry.source, {
        flag: "wx",
        mode: 0o644,
      });
    }
    await writeFile(
      join(output, "manifest.json"),
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o644 },
    );
    return fixture.manifest;
  } catch (error) {
    if (created) await rm(output, { recursive: true, force: true });
    if (error instanceof SketchExportError) throw error;
    fail("LESSON_EXPORT_FAILED");
  }
}

async function main() {
  const outputDirectory = process.argv[2];
  if (process.argv.length !== 3 || typeof outputDirectory !== "string") {
    fail("USAGE");
  }
  const manifest = await exportLessonSketches(outputDirectory);
  process.stdout.write(
    `Exported ${String(manifest.count)} typed Firelight lesson sketches.\n`,
  );
}

function isDirectExecution() {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    const code = error instanceof SketchExportError ? error.code : "LESSON_EXPORT_FAILED";
    process.stderr.write(`Lesson sketch export failed [${code}].\n`);
    process.exitCode = 1;
  });
}
