export interface ServiceConfig {
  host: string;
  port: number;
  allowedOrigins: ReadonlySet<string> | "local";
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 4317;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${value}`);
  }
  return port;
}

export function loadConfig(
  environment: Record<string, string | undefined>,
): ServiceConfig {
  const origins = environment.CORS_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    host: environment.HOST?.trim() || "127.0.0.1",
    port: parsePort(environment.PORT),
    allowedOrigins:
      origins === undefined ? "local" : new Set<string>(origins),
  };
}

export function isOriginAllowed(
  origin: string | null,
  allowedOrigins: ServiceConfig["allowedOrigins"],
): boolean {
  if (origin === null) return true;
  if (allowedOrigins !== "local") return allowedOrigins.has(origin);

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}
