import { createServer } from "vite";
import { stdout } from "node:process";

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  server: { middlewareMode: true },
});

try {
  const catalogModule = await server.ssrLoadModule(
    "/src/features/lessons/catalog.ts",
  );
  if (!Array.isArray(catalogModule.lessonCatalog)) {
    throw new TypeError("Lesson catalog validation did not return a catalog array.");
  }
  stdout.write(
    `Validated ${String(catalogModule.lessonCatalog.length)} Firelight lessons.\n`,
  );
} finally {
  await server.close();
}
