import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          ENVIRONMENT: "development",
          SUPABASE_URL: "https://supabase.firelight.test",
          SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
          SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
          KIT_CODE_PEPPER: "firelight-local-kit-pepper",
          COMPILER_SERVICE_URL: "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws/",
          COMPILER_SERVICE_ORIGIN:
            "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws",
          COMPILER_SERVICE_TOKEN:
            "test-service-token-that-is-at-least-thirty-two-characters",
        },
      },
    }),
  ],
  test: {
    include: ["worker/**/*.test.ts"],
    // Workerd isolates are relatively heavy and the CI gate values determinism
    // over file-level parallelism. Test cases inside each file still run normally.
    fileParallelism: false,
  },
});
