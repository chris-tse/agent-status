export interface ServiceConfig {
  host: string;
  port: number;
  allowedOrigins: ReadonlySet<string> | "local";
  provider: "demo" | "herdr";
  herdrSocketPath: string;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 4317;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${value}`);
  }
  return port;
}

function parseProvider(value: string | undefined): ServiceConfig["provider"] {
  const provider = value?.trim() || "demo";
  if (provider !== "demo" && provider !== "herdr") {
    throw new Error(
      `STATUS_PROVIDER must be "demo" or "herdr"; received ${provider}`,
    );
  }
  return provider;
}

function resolveHerdrSocketPath(
  environment: Record<string, string | undefined>,
): string {
  const explicit = environment.HERDR_SOCKET_PATH?.trim();
  if (explicit) return explicit;

  const configHome =
    environment.XDG_CONFIG_HOME?.trim() ||
    (environment.HOME?.trim()
      ? `${environment.HOME.trim()}/.config`
      : undefined);
  if (configHome === undefined) return "/tmp/herdr.sock";

  const session = environment.HERDR_SESSION?.trim();
  if (
    session === undefined ||
    session.length === 0 ||
    session === "default"
  ) {
    return `${configHome}/herdr/herdr.sock`;
  }
  if (
    session.length > 64 ||
    session === "." ||
    session === ".." ||
    !/^[a-zA-Z0-9._-]+$/.test(session)
  ) {
    throw new Error(
      "HERDR_SESSION may contain only letters, numbers, dots, underscores, and hyphens",
    );
  }
  return `${configHome}/herdr/sessions/${session}/herdr.sock`;
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
    provider: parseProvider(environment.STATUS_PROVIDER),
    herdrSocketPath: resolveHerdrSocketPath(environment),
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
