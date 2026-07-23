export interface EmbeddedStatusService {
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DesktopPresentation {
  isOpen(): boolean;
  open(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeHost {
  quit(): void;
}

export interface DesktopRuntime {
  status(): DesktopRuntimeStatus;
  openApplication(): Promise<void>;
  showPresentation(): Promise<void>;
  closePresentation(): Promise<void>;
  startService(): Promise<void>;
  stopService(): Promise<void>;
  restartService(): Promise<void>;
  stopServiceAndQuit(): Promise<void>;
}

export interface DesktopRuntimeStatus {
  readonly serviceRunning: boolean;
  readonly presentationOpen: boolean;
}

export function createDesktopRuntime({
  service,
  presentation,
  host,
}: {
  service: EmbeddedStatusService;
  presentation: DesktopPresentation;
  host: RuntimeHost;
}): DesktopRuntime {
  let mutation: Promise<void> = Promise.resolve();

  function mutate(operation: () => Promise<void>): Promise<void> {
    const result = mutation.then(operation, operation);
    mutation = result.catch(() => {});
    return result;
  }

  const startService = async () => {
    if (!service.isRunning()) await service.start();
  };
  const stopService = async () => {
    if (service.isRunning()) await service.stop();
  };

  return {
    status: () => ({
      serviceRunning: service.isRunning(),
      presentationOpen: presentation.isOpen(),
    }),
    openApplication: async () =>
      await mutate(async () => {
        await startService();
        if (!presentation.isOpen()) await presentation.open();
      }),
    showPresentation: async () =>
      await mutate(async () => {
        if (!presentation.isOpen()) await presentation.open();
      }),
    closePresentation: async () =>
      await mutate(async () => {
        if (presentation.isOpen()) await presentation.close();
      }),
    startService: async () => await mutate(startService),
    stopService: async () => await mutate(stopService),
    restartService: async () =>
      await mutate(async () => {
        await stopService();
        await startService();
      }),
    stopServiceAndQuit: async () =>
      await mutate(async () => {
        if (presentation.isOpen()) await presentation.close();
        await stopService();
        host.quit();
      }),
  };
}
