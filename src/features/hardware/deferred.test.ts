import { describe, expect, it } from "vitest";
import { inspectDeferredHardware } from "./deferred";

describe("deferred hardware capability", () => {
  it("keeps actions unavailable even when desktop Web Serial is present", () => {
    expect(
      inspectDeferredHardware({
        secureContext: true,
        userAgent: "Mozilla/5.0 Chrome/140",
        serialAvailable: true,
      }),
    ).toMatchObject({
      browserReady: true,
      actionsReady: false,
      reason: "milestone-pending",
    });
  });

  it("gives mobile and unsupported browsers a specific read-only reason", () => {
    expect(
      inspectDeferredHardware({
        secureContext: true,
        userAgent: "Mozilla/5.0 (iPhone)",
        serialAvailable: false,
      }).reason,
    ).toBe("mobile-device");
    expect(
      inspectDeferredHardware({
        secureContext: true,
        userAgent: "Firefox",
        serialAvailable: false,
      }).reason,
    ).toBe("web-serial-unavailable");
  });
});
