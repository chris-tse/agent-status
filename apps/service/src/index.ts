import { createStatusServer } from "./server.js";

export { SubscriptionBroadcaster } from "./broadcast.js";
export { loadConfig, isOriginAllowed } from "./config.js";
export { DemoController } from "./demo-controller.js";
export { HerdrStatusProvider, type HerdrStatusProviderOptions } from "./herdr-provider.js";
export {
  createDefaultServiceLifecycle,
  createServiceLifecycle,
  type DefaultServiceLifecycleOptions,
  type ServiceLifecycle,
  type ServiceLifecycleOptions,
  type ServiceLifecycleState,
  type ServiceLifecycleStatus,
  type ServiceSupervisor,
} from "./lifecycle.js";
export {
  createLaunchdSupervisor,
  type CommandResult,
  type CommandRunner,
  type LaunchdSupervisorOptions,
} from "./launchd.js";
export type {
  DemoStatusProvider,
  ProviderAdvance,
  ProviderConnection,
  ProviderListener,
  ProviderMessage,
  StatusProvider,
} from "./provider.js";
export { demoResourceIds, SimulatedStatusProvider } from "./simulated-provider.js";
export { DashboardStore, type Clock, type DashboardState } from "./store.js";
export {
  createStatusServer,
  handleStatusRequest,
  type RequestContext,
  type RunningStatusServer,
  type StatusServerOptions,
} from "./server.js";

if (import.meta.main) {
  const service = createStatusServer();
  console.info(`Status service listening on ${service.server.url.toString()} (WebSocket: /ws)`);
}
