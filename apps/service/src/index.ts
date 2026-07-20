import { createStatusServer } from "./server.js";

export { SubscriptionBroadcaster } from "./broadcast.js";
export { loadConfig, isOriginAllowed } from "./config.js";
export { DemoController } from "./demo-controller.js";
export type {
  ProviderAdvance,
  StatusProvider,
} from "./provider.js";
export {
  demoResourceIds,
  SimulatedStatusProvider,
} from "./simulated-provider.js";
export {
  DashboardStore,
  type Clock,
  type DashboardState,
} from "./store.js";
export {
  createStatusServer,
  type RunningStatusServer,
  type StatusServerOptions,
} from "./server.js";

if (import.meta.main) {
  const service = createStatusServer();
  console.info(
    `Status service listening on ${service.server.url.toString()} (WebSocket: /ws)`,
  );
}
