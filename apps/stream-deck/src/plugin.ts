import streamDeck from "@elgato/streamdeck";

import { AgentSlotAction } from "./actions/agent-slot.js";
import { DashboardClient } from "./dashboard-client.js";

type GlobalSettings = {
  endpoint?: string;
};

streamDeck.logger.setLevel("debug");

const client = new DashboardClient({
  debug: (message) => streamDeck.logger.debug(message),
  error: (message) => streamDeck.logger.error(message),
  warn: (message) => streamDeck.logger.warn(message),
});

streamDeck.actions.registerAction(new AgentSlotAction(client));

await streamDeck.connect();

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((event) => {
  client.setEndpoint(event.settings.endpoint);
});

const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
client.setEndpoint(settings.endpoint);
client.start();
