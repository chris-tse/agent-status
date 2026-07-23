import { describe, expect, test } from "vitest";

import {
  createDesktopRuntime,
  type DesktopPresentation,
  type EmbeddedStatusService,
  type RuntimeHost,
} from "../src/desktop-runtime";

function setup() {
  let serviceRunning = false;
  let presentationOpen = false;
  let quitRequested = false;

  const service: EmbeddedStatusService = {
    isRunning: () => serviceRunning,
    start: async () => {
      serviceRunning = true;
    },
    stop: async () => {
      serviceRunning = false;
    },
  };
  const presentation: DesktopPresentation = {
    isOpen: () => presentationOpen,
    open: async () => {
      presentationOpen = true;
    },
    close: async () => {
      presentationOpen = false;
    },
  };
  const host: RuntimeHost = {
    quit: () => {
      quitRequested = true;
    },
  };

  return {
    runtime: createDesktopRuntime({ service, presentation, host }),
    state: () => ({ serviceRunning, presentationOpen, quitRequested }),
  };
}

describe("Electrobun desktop runtime", () => {
  test("opening the application starts the real service and dashboard", async () => {
    const { runtime, state } = setup();

    await runtime.openApplication();

    expect(state()).toEqual({
      serviceRunning: true,
      presentationOpen: true,
      quitRequested: false,
    });
  });

  test("closing the presentation leaves the service available to ambient consumers", async () => {
    const { runtime, state } = setup();
    await runtime.openApplication();

    await runtime.closePresentation();

    expect(state()).toEqual({
      serviceRunning: true,
      presentationOpen: false,
      quitRequested: false,
    });
  });

  test("an explicit stop remains stopped while the dashboard is reopened", async () => {
    const { runtime, state } = setup();
    await runtime.openApplication();

    await runtime.stopService();
    await runtime.closePresentation();
    await runtime.showPresentation();

    expect(state()).toEqual({
      serviceRunning: false,
      presentationOpen: true,
      quitRequested: false,
    });
  });

  test("stop service and quit performs complete cleanup before terminating", async () => {
    const { runtime, state } = setup();
    await runtime.openApplication();

    await runtime.stopServiceAndQuit();

    expect(state()).toEqual({
      serviceRunning: false,
      presentationOpen: false,
      quitRequested: true,
    });
  });
});
