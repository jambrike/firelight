import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findClientEntrySource,
  inspectClientBundle,
} from "./check-client-bundle.mjs";

const DEFERRED_IMPORTS =
  'import("./LessonPage-lesson.js"); import("./AdminPage-admin.js");';

async function bundleFixture({
  entry = Buffer.from(`${DEFERRED_IMPORTS} export const firelight = true;`),
  entrySource = "/assets/index-fixture.js",
  chunks = ["LessonPage-lesson.js", "AdminPage-admin.js"],
  extraAssets = {},
  modulePreloads = [],
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "firelight-client-bundle-"));
  const assets = join(directory, "assets");
  await mkdir(assets);
  const preloadMarkup = modulePreloads
    .map((source) => `<link href="/assets/${source}" rel="modulepreload">`)
    .join("");
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html>${preloadMarkup}<script crossorigin type="module" src="${entrySource}"></script>`,
  );
  const entryName = entrySource.startsWith("/assets/")
    ? entrySource.slice("/assets/".length)
    : "index-fixture.js";
  await writeFile(join(assets, entryName), entry);
  await Promise.all([
    ...chunks.map((name) => writeFile(join(assets, name), "export {};")),
    ...Object.entries(extraAssets).map(([name, contents]) =>
      writeFile(join(assets, name), contents)
    ),
  ]);
  return directory;
}

test("finds exactly one versioned module entry regardless of attribute order", () => {
  assert.equal(
    findClientEntrySource(
      '<script crossorigin src="/assets/index-Ab_12.js" type="module"></script>',
    ),
    "/assets/index-Ab_12.js",
  );
  assert.throws(
    () => findClientEntrySource('<script type="module" src="../secret.js"></script>'),
    /versioned client entry/u,
  );
  assert.throws(
    () => findClientEntrySource(
      '<script type="module" src="/assets/%2e%2e/secret.js"></script>',
    ),
    /versioned client entry/u,
  );
  assert.throws(
    () => findClientEntrySource(
      '<script type="module" src="/assets/index-one.js"></script>' +
        '<script type="module" src="/assets/index-two.js"></script>',
    ),
    /one versioned client entry/u,
  );
  for (const misleadingMarkup of [
    '<!-- <script type="module" src="/assets/index-comment.js"></script> -->',
    '<script data-note=\'type="module" src="/assets/index-note.js"\'></script>',
    '<script data-type="module" data-src="/assets/index-data.js"></script>',
  ]) {
    assert.throws(
      () => findClientEntrySource(misleadingMarkup),
      /one versioned client entry/u,
    );
  }
});

test("accepts a bounded graph with dynamically imported lesson and admin chunks", async (context) => {
  const directory = await bundleFixture();
  context.after(() => rm(directory, { recursive: true, force: true }));

  const result = await inspectClientBundle({
    distDirectory: directory,
    rawLimitBytes: 1_000,
    gzipLimitBytes: 1_000,
  });

  assert.equal(result.entryName, "index-fixture.js");
  assert.deepEqual(result.initialModules, ["index-fixture.js"]);
  assert.deepEqual(result.deferredChunks, {
    LessonPage: "LessonPage-lesson.js",
    AdminPage: "AdminPage-admin.js",
  });
});

test("counts transitive static imports and module preloads in the initial budget", async (context) => {
  const staticDirectory = await bundleFixture({
    entry: Buffer.from(`import "./vendor.js"; ${DEFERRED_IMPORTS}`),
    extraAssets: { "vendor.js": "x".repeat(2_000) },
  });
  const preloadDirectory = await bundleFixture({
    modulePreloads: ["vendor.js"],
    extraAssets: { "vendor.js": "x".repeat(2_000) },
  });
  context.after(async () => {
    await Promise.all([
      rm(staticDirectory, { recursive: true, force: true }),
      rm(preloadDirectory, { recursive: true, force: true }),
    ]);
  });

  for (const directory of [staticDirectory, preloadDirectory]) {
    await assert.rejects(
      inspectClientBundle({
        distDirectory: directory,
        rawLimitBytes: 1_000,
        gzipLimitBytes: 10_000,
      }),
      /Initial client graph exceeds its budget/u,
    );
  }
});

test("rejects raw and gzip initial-graph regressions", async (context) => {
  const entry = Buffer.from(
    `${DEFERRED_IMPORTS}${Array.from({ length: 2_048 }, (_, index) =>
      String.fromCharCode(32 + (index % 90))).join("")}`,
  );
  const directory = await bundleFixture({ entry });
  context.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    inspectClientBundle({
      distDirectory: directory,
      rawLimitBytes: entry.byteLength - 1,
      gzipLimitBytes: 10_000,
    }),
    /exceeds its budget/u,
  );
  await assert.rejects(
    inspectClientBundle({
      distDirectory: directory,
      rawLimitBytes: 10_000,
      gzipLimitBytes: 1,
    }),
    /exceeds its budget/u,
  );
});

test("rejects unreferenced, eager, ambiguous, and unsafe route chunks", async (context) => {
  const unreferencedDirectory = await bundleFixture({ entry: Buffer.from("export {};") });
  const eagerDirectory = await bundleFixture({
    entry: Buffer.from(
      'import "./LessonPage-lesson.js"; import("./AdminPage-admin.js");',
    ),
  });
  const ambiguousDirectory = await bundleFixture({
    entry: Buffer.from(
      `${DEFERRED_IMPORTS} import("./LessonPage-second.js");`,
    ),
    chunks: ["LessonPage-lesson.js", "LessonPage-second.js", "AdminPage-admin.js"],
  });
  const unsafeDirectory = await bundleFixture({
    entry: Buffer.from(`import "../escape.js"; ${DEFERRED_IMPORTS}`),
  });
  context.after(async () => {
    await Promise.all(
      [unreferencedDirectory, eagerDirectory, ambiguousDirectory, unsafeDirectory]
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  await assert.rejects(
    inspectClientBundle({ distDirectory: unreferencedDirectory }),
    /dynamically imported LessonPage chunk, found 0/u,
  );
  await assert.rejects(
    inspectClientBundle({ distDirectory: eagerDirectory }),
    /dynamically imported LessonPage chunk, found 0/u,
  );
  await assert.rejects(
    inspectClientBundle({ distDirectory: ambiguousDirectory }),
    /dynamically imported LessonPage chunk, found 2/u,
  );
  await assert.rejects(
    inspectClientBundle({ distDirectory: unsafeDirectory }),
    /escaped the versioned assets directory/u,
  );
});
