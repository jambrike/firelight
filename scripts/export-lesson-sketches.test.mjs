import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPECTED_LESSON_IDS,
  FIRELIGHT_BOARD_FQBN,
  LESSON_FIXTURE_SCHEMA,
  LESSON_FIXTURE_VERSION,
  PINNED_TOOLCHAIN,
  SketchExportError,
  buildLessonFixture,
  exportLessonSketches,
} from "./export-lesson-sketches.mjs";

function catalog() {
  return EXPECTED_LESSON_IDS.map((id, index) => ({
    id,
    order: index + 1,
    version: 1,
    starterCode: `// ${id}\nvoid setup() {}\nvoid loop() {}\n`,
  }));
}

function assertExportCode(expected) {
  return (error) => {
    assert.ok(error instanceof SketchExportError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("fixture construction requires the exact ordered six-lesson catalog", () => {
  const fixture = buildLessonFixture(catalog());
  assert.deepEqual(fixture.manifest, {
    schema: LESSON_FIXTURE_SCHEMA,
    version: LESSON_FIXTURE_VERSION,
    fqbn: FIRELIGHT_BOARD_FQBN,
    toolchain: PINNED_TOOLCHAIN,
    count: 6,
    sketches: EXPECTED_LESSON_IDS.map((id) => {
      const source = Buffer.from(`// ${id}\nvoid setup() {}\nvoid loop() {}\n`);
      const sketchName = id.replaceAll("-", "_");
      return {
        id,
        version: 1,
        relativePath: `${sketchName}/${sketchName}.ino`,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
      };
    }),
  });

  assert.throws(
    () => buildLessonFixture(catalog().slice(0, 5)),
    assertExportCode("LESSON_COUNT_MISMATCH"),
  );
  const reordered = catalog();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(
    () => buildLessonFixture(reordered),
    assertExportCode("LESSON_CATALOG_MISMATCH"),
  );
  const carriageReturn = catalog();
  carriageReturn[0] = { ...carriageReturn[0], starterCode: "void setup() {}\r\n" };
  assert.throws(
    () => buildLessonFixture(carriageReturn),
    assertExportCode("LESSON_CATALOG_MISMATCH"),
  );
});

test("export writes deterministic hash-bound sketches and refuses overwrite", async () => {
  const parent = await mkdtemp(join(tmpdir(), "firelight-sketch-export-test-"));
  const output = join(parent, "fixtures");
  try {
    const manifest = await exportLessonSketches(output, {
      loadCatalogImpl: async () => catalog(),
    });
    assert.equal(manifest.count, 6);

    const serialized = await readFile(join(output, "manifest.json"), "utf8");
    assert.equal(serialized, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const sketch of manifest.sketches) {
      const source = await readFile(join(output, sketch.relativePath));
      assert.equal(createHash("sha256").update(source).digest("hex"), sketch.sourceSha256);
    }

    await assert.rejects(
      exportLessonSketches(output, { loadCatalogImpl: async () => catalog() }),
      assertExportCode("OUTPUT_DIRECTORY_EXISTS"),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the real typed catalog exports exactly the accepted six sketches", async () => {
  const parent = await mkdtemp(join(tmpdir(), "firelight-real-sketch-export-test-"));
  const output = join(parent, "fixtures");
  try {
    const manifest = await exportLessonSketches(output);
    assert.equal(manifest.count, 6);
    assert.deepEqual(manifest.sketches.map((entry) => entry.id), EXPECTED_LESSON_IDS);
    assert.deepEqual(manifest.toolchain, PINNED_TOOLCHAIN);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
