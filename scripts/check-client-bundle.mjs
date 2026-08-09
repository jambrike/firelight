import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse } from "parse5";
import ts from "typescript";

export const CLIENT_ENTRY_RAW_LIMIT_BYTES = 525_000;
export const CLIENT_ENTRY_GZIP_LIMIT_BYTES = 150_000;
export const REQUIRED_DEFERRED_CHUNKS = ["LessonPage", "AdminPage"];

const INDEX_HTML_LIMIT_BYTES = 128 * 1024;
const ENTRY_SOURCE_PATTERN = /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u;
const ASSET_MODULE_PATTERN = /^\/assets\/[A-Za-z0-9._-]+\.js$/u;
const BUILD_ORIGIN = "https://firelight.invalid";

function fail(message) {
  throw new TypeError(message);
}

function indexDocument(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > INDEX_HTML_LIMIT_BYTES) {
    fail("The built index is missing or too large.");
  }
  const parseErrors = [];
  const document = parse(html, {
    onParseError(error) {
      if (error.code !== "missing-doctype") parseErrors.push(error.code);
    },
  });
  if (parseErrors.length > 0) fail("The built index contains invalid HTML.");
  return document;
}

function elementsNamed(root, tagName) {
  const matches = [];
  function visit(node) {
    if (node.tagName === tagName) matches.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(root);
  return matches;
}

function elementAttribute(element, name) {
  return element.attrs?.find((item) => item.name === name)?.value ?? null;
}

export function findClientEntrySource(html) {
  const moduleSources = elementsNamed(indexDocument(html), "script").flatMap((element) => {
    const type = elementAttribute(element, "type");
    const source = elementAttribute(element, "src");
    return type?.toLowerCase() === "module" && source ? [source] : [];
  });
  if (moduleSources.length !== 1 || !ENTRY_SOURCE_PATTERN.test(moduleSources[0])) {
    fail("The built index must reference one versioned client entry under /assets.");
  }
  return moduleSources[0];
}

function findModulePreloadSources(html) {
  return elementsNamed(indexDocument(html), "link").flatMap((element) => {
    const relation = elementAttribute(element, "rel");
    const source = elementAttribute(element, "href");
    if (relation?.toLowerCase() !== "modulepreload" || !source) return [];
    if (!ASSET_MODULE_PATTERN.test(source)) {
      fail("Every module preload must reference a versioned JavaScript asset.");
    }
    return [source];
  });
}

function moduleNameFromUrl(source) {
  if (!ASSET_MODULE_PATTERN.test(source)) {
    fail("A client module escaped the versioned assets directory.");
  }
  return source.slice("/assets/".length);
}

function resolveModuleSpecifier(importerName, specifier) {
  if (typeof specifier !== "string" || specifier.includes("%")) {
    fail("A built client import has an unsafe module specifier.");
  }
  let resolved;
  try {
    resolved = new URL(specifier, `${BUILD_ORIGIN}/assets/${importerName}`);
  } catch {
    fail("A built client import has an invalid module specifier.");
  }
  if (
    resolved.origin !== BUILD_ORIGIN ||
    resolved.search.length > 0 ||
    resolved.hash.length > 0 ||
    !ASSET_MODULE_PATTERN.test(resolved.pathname)
  ) {
    fail("A built client import escaped the versioned assets directory.");
  }
  return moduleNameFromUrl(resolved.pathname);
}

function parseModuleReferences(source, moduleName) {
  const sourceFile = ts.createSourceFile(
    moduleName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    fail(`The built client module ${moduleName} is not valid JavaScript.`);
  }

  const staticImports = [];
  const dynamicImports = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      staticImports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) dynamicImports.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { staticImports, dynamicImports };
}

export async function inspectClientBundle({
  distDirectory,
  rawLimitBytes = CLIENT_ENTRY_RAW_LIMIT_BYTES,
  gzipLimitBytes = CLIENT_ENTRY_GZIP_LIMIT_BYTES,
  requiredDeferredChunks = REQUIRED_DEFERRED_CHUNKS,
}) {
  if (!Number.isSafeInteger(rawLimitBytes) || rawLimitBytes < 1) {
    fail("The raw initial-module budget is invalid.");
  }
  if (!Number.isSafeInteger(gzipLimitBytes) || gzipLimitBytes < 1) {
    fail("The gzip initial-module budget is invalid.");
  }

  const html = await readFile(join(distDirectory, "index.html"), "utf8");
  const entrySource = findClientEntrySource(html);
  const initialQueue = [
    moduleNameFromUrl(entrySource),
    ...findModulePreloadSources(html).map(moduleNameFromUrl),
  ];
  const assetsDirectory = join(distDirectory, "assets");
  const assetNames = new Set(await readdir(assetsDirectory));
  const initialModules = new Set();
  const dynamicModules = new Set();
  let rawBytes = 0;
  let gzipBytes = 0;

  while (initialQueue.length > 0) {
    const moduleName = initialQueue.shift();
    if (!moduleName || initialModules.has(moduleName)) continue;
    if (!assetNames.has(moduleName)) fail(`Built client module ${moduleName} is missing.`);

    const source = await readFile(join(assetsDirectory, moduleName));
    initialModules.add(moduleName);
    rawBytes += source.byteLength;
    gzipBytes += gzipSync(source, { level: 9 }).byteLength;
    if (rawBytes > rawLimitBytes || gzipBytes > gzipLimitBytes) {
      fail(
        `Initial client graph exceeds its budget (${String(rawBytes)}/${String(rawLimitBytes)} ` +
          `raw, ${String(gzipBytes)}/${String(gzipLimitBytes)} gzip bytes).`,
      );
    }

    const references = parseModuleReferences(source.toString("utf8"), moduleName);
    for (const specifier of references.staticImports) {
      initialQueue.push(resolveModuleSpecifier(moduleName, specifier));
    }
    for (const specifier of references.dynamicImports) {
      dynamicModules.add(resolveModuleSpecifier(moduleName, specifier));
    }
  }

  const deferredChunks = {};
  for (const prefix of requiredDeferredChunks) {
    if (typeof prefix !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/u.test(prefix)) {
      fail("A deferred client-chunk name is invalid.");
    }
    const pattern = new RegExp(`^${prefix}-[A-Za-z0-9_-]+\\.js$`, "u");
    const matches = [...dynamicModules].filter((name) => pattern.test(name));
    if (matches.length !== 1) {
      fail(`Expected one dynamically imported ${prefix} chunk, found ${String(matches.length)}.`);
    }
    const chunk = matches[0];
    if (!assetNames.has(chunk) || initialModules.has(chunk)) {
      fail(`The ${prefix} chunk must exist outside the initial client graph.`);
    }
    deferredChunks[prefix] = chunk;
  }

  return {
    entryName: moduleNameFromUrl(entrySource),
    initialModules: [...initialModules].sort(),
    rawBytes,
    gzipBytes,
    deferredChunks,
  };
}

async function main() {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = await inspectClientBundle({
    distDirectory: join(repositoryRoot, "dist"),
  });
  process.stdout.write(
    `Verified initial client graph from ${result.entryName}: ${String(result.rawBytes)} raw / ` +
      `${String(result.gzipBytes)} gzip bytes; lesson and admin routes remain deferred.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown bundle-check failure.";
    process.stderr.write(`Client-bundle verification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
