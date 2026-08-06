import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const legacyRedirects = [
  ["/index.html", "/"],
  ["/dashboard.html", "/camp"],
  ["/learn.html", "/learn"],
  ["/product.html", "/kit"],
  ["/tutorial.html", "/learn/first-spark"],
  ["/second-tutorial", "/learn/morse-name"],
  ["/second-tutorial/", "/learn/morse-name"],
  ["/second-tutorial/index.html", "/learn/morse-name"],
] as const;

describe("Firelight Worker", () => {
  it("returns public runtime configuration in the shared response envelope", async () => {
    const response = await exports.default.fetch("https://firelight.test/api/config");
    const body = await response.json<{
      data: {
        apiVersion: string;
        environment: string;
        hardware: { fqbn: string; uploadBaud: number };
      };
    }>();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(body.data.apiVersion).toBe("v1");
    expect(body.data.environment).toBe("development");
    expect(body.data.hardware).toEqual({
      fqbn: "arduino:avr:nano:cpu=atmega328old",
      uploadBaud: 57_600,
    });
  });

  it.each(["/api", "/api/unknown"])(
    "returns a non-cacheable structured error for %s",
    async (path) => {
      const response = await exports.default.fetch(`https://firelight.test${path}`);
      const body = await response.json<{
        error: { code: string; message: string; requestId: string };
      }>();

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
    },
  );

  it("advertises every supported config method on a non-cacheable 405", async () => {
    const response = await exports.default.fetch("https://firelight.test/api/config", {
      method: "POST",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(legacyRedirects)("redirects %s to %s", async (legacyPath, destination) => {
    const response = await exports.default.fetch(`https://firelight.test${legacyPath}`, {
      redirect: "manual",
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://firelight.test${destination}`);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves SPA navigation through the static asset binding with security headers", async () => {
    const response = await exports.default.fetch("https://firelight.test/learn/first-spark", {
      headers: {
        "Sec-Fetch-Mode": "navigate",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
