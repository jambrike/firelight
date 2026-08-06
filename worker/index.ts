import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

interface FirelightWorker {
  Bindings: Env;
  Variables: {
    requestId: string;
  };
}

type ErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 429 | 500 | 502 | 503;

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=(), serial=(self)",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function applyResponseHeaders(context: Context<FirelightWorker>): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    context.header(name, value);
  }

  if (isApiPath(context.req.path)) {
    context.header("Cache-Control", "no-store");
  }
}

const requestContext: MiddlewareHandler<FirelightWorker> = async (context, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  context.set("requestId", requestId);
  context.header("X-Request-ID", requestId);

  await next();

  applyResponseHeaders(context);

  console.log(
    JSON.stringify({
      event: "request.complete",
      requestId,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Date.now() - startedAt,
    }),
  );
};

function apiError(
  context: Context<FirelightWorker>,
  status: ErrorStatus,
  code: string,
  message: string,
) {
  return context.json(
    {
      error: {
        code,
        message,
        requestId: context.get("requestId"),
      },
    },
    status,
  );
}

const app = new Hono<FirelightWorker>();

app.use("*", requestContext);

app.get("/api/config", (context) => {
  return context.json({
    data: {
      apiVersion: "v1",
      environment: context.env.ENVIRONMENT,
      buildId: context.env.BUILD_ID,
      hardware: {
        fqbn: "arduino:avr:nano:cpu=atmega328old",
        uploadBaud: 57_600,
      },
    },
  });
});

app.all("/api/config", (context) => {
  context.header("Allow", "GET, HEAD");
  return apiError(
    context,
    405,
    "METHOD_NOT_ALLOWED",
    "This endpoint only accepts GET or HEAD requests.",
  );
});

const legacyRedirects = {
  "/index.html": "/",
  "/dashboard.html": "/camp",
  "/learn.html": "/learn",
  "/product.html": "/kit",
  "/tutorial.html": "/learn/first-spark",
  "/second-tutorial": "/learn/morse-name",
  "/second-tutorial/": "/learn/morse-name",
  "/second-tutorial/index.html": "/learn/morse-name",
} as const;

for (const [legacyPath, destination] of Object.entries(legacyRedirects)) {
  app.get(legacyPath, (context) => {
    const redirectUrl = new URL(destination, context.req.url);
    return context.redirect(redirectUrl.toString(), 308);
  });
}

app.notFound((context) => {
  if (!isApiPath(context.req.path)) {
    return context.env.ASSETS.fetch(context.req.raw);
  }

  return apiError(context, 404, "NOT_FOUND", "The requested API route does not exist.");
});

app.onError((error, context) => {
  const requestId = context.get("requestId");

  console.error(
    JSON.stringify({
      event: "request.error",
      requestId,
      method: context.req.method,
      path: context.req.path,
      errorType: error.name,
    }),
  );

  applyResponseHeaders(context);

  return apiError(
    context,
    500,
    "INTERNAL_ERROR",
    "Firelight could not complete the request.",
  );
});

export { app };
export default app;
