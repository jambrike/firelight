export type DeferredHardwareReason =
  | "mobile-device"
  | "not-secure-context"
  | "web-serial-unavailable"
  | "milestone-pending";

export interface DeferredHardwareAvailability {
  readonly browserReady: boolean;
  readonly actionsReady: false;
  readonly reason: DeferredHardwareReason;
  readonly message: string;
}

interface BrowserSignals {
  readonly secureContext: boolean;
  readonly userAgent: string;
  readonly serialAvailable: boolean;
}

export function inspectDeferredHardware(
  signals: BrowserSignals,
): DeferredHardwareAvailability {
  if (/Android|iPad|iPhone|iPod|Mobi/i.test(signals.userAgent)) {
    return {
      browserReady: false,
      actionsReady: false,
      reason: "mobile-device",
      message: "Read along here, then use desktop Chrome or Edge for the board steps.",
    };
  }
  if (!signals.secureContext) {
    return {
      browserReady: false,
      actionsReady: false,
      reason: "not-secure-context",
      message: "Board access needs a secure HTTPS page or localhost.",
    };
  }
  if (!signals.serialAvailable) {
    return {
      browserReady: false,
      actionsReady: false,
      reason: "web-serial-unavailable",
      message: "Use desktop Chrome or Edge with Web Serial enabled for hardware steps.",
    };
  }
  return {
    browserReady: true,
    actionsReady: false,
    reason: "milestone-pending",
    message: "Browser ready. Compile, connect, and upload arrive in the hardware milestone.",
  };
}

export function inspectCurrentBrowserHardware(): DeferredHardwareAvailability {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return inspectDeferredHardware({
      secureContext: false,
      userAgent: "",
      serialAvailable: false,
    });
  }
  return inspectDeferredHardware({
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    serialAvailable: "serial" in navigator,
  });
}
