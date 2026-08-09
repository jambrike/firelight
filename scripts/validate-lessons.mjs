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
  const codeValidationModule = await server.ssrLoadModule(
    "/src/features/lessons/code-validation.ts",
  );
  if (!Array.isArray(catalogModule.lessonCatalog)) {
    throw new TypeError("Lesson catalog validation did not return a catalog array.");
  }
  if (typeof codeValidationModule.validateLessonCode !== "function") {
    throw new TypeError("Lesson code validation did not export validateLessonCode().");
  }

  for (const lesson of catalogModule.lessonCatalog) {
    const validationSteps = lesson.steps.filter(
      (step) => step.type === "code-validation",
    );
    if (validationSteps.length !== 1) {
      throw new TypeError(
        `Lesson "${lesson.id}" must contain exactly one code-validation step.`,
      );
    }
    const result = codeValidationModule.validateLessonCode(
      validationSteps[0].validatorId,
      lesson.starterCode,
    );
    if (!result.valid) {
      throw new TypeError(
        `Lesson "${lesson.id}" starter code failed local validation:\n- ${result.messages.join("\n- ")}`,
      );
    }
  }

  stdout.write(
    `Validated ${String(catalogModule.lessonCatalog.length)} Firelight lessons and starter sketches.\n`,
  );
} finally {
  await server.close();
}
