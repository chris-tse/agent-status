import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("service provider configuration", () => {
  it("keeps the simulator as the default provider", () => {
    expect(loadConfig({ HOME: "/Users/example" })).toMatchObject({
      provider: "demo",
      herdrSocketPath: "/Users/example/.config/herdr/herdr.sock",
    });
  });

  it("resolves named Herdr sessions and explicit socket overrides", () => {
    expect(
      loadConfig({
        STATUS_PROVIDER: "herdr",
        XDG_CONFIG_HOME: "/tmp/config",
        HERDR_SESSION: "agents",
      }),
    ).toMatchObject({
      provider: "herdr",
      herdrSocketPath: "/tmp/config/herdr/sessions/agents/herdr.sock",
    });
    expect(
      loadConfig({
        STATUS_PROVIDER: "herdr",
        HERDR_SOCKET_PATH: "/tmp/custom.sock",
      }).herdrSocketPath,
    ).toBe("/tmp/custom.sock");
    expect(
      loadConfig({
        STATUS_PROVIDER: "herdr",
        HOME: "/Users/example",
        HERDR_SESSION: "default",
      }).herdrSocketPath,
    ).toBe("/Users/example/.config/herdr/herdr.sock");
  });

  it("rejects unsupported providers and unsafe session names", () => {
    expect(() => loadConfig({ STATUS_PROVIDER: "other" })).toThrow(
      /STATUS_PROVIDER/,
    );
    expect(() =>
      loadConfig({ HOME: "/tmp", HERDR_SESSION: "../other" }),
    ).toThrow(/HERDR_SESSION/);
  });
});
