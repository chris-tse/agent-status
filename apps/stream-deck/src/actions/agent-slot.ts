import {
  action,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import {
  type DashboardClient,
  type DashboardClientSnapshot,
} from "../dashboard-client.js";
import { renderKeyImage } from "../key-image.js";
import { SlotPool } from "../slot-pool.js";

export const AGENT_SLOT_ACTION_UUID =
  "com.status-dashboard.stream-deck.agent-slot";

@action({ UUID: AGENT_SLOT_ACTION_UUID })
export class AgentSlotAction extends SingletonAction {
  readonly #client: DashboardClient;
  readonly #pool = new SlotPool();
  readonly #visibleActions = new Map<string, KeyAction>();
  #snapshot: DashboardClientSnapshot;

  constructor(client: DashboardClient) {
    super();
    this.#client = client;
    this.#snapshot = client.snapshot;
    client.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.#pool.reconcile(snapshot.resources);
      this.renderAll();
    });
  }

  override onWillAppear(event: WillAppearEvent): void {
    if (!event.action.isKey()) {
      return;
    }

    this.#visibleActions.set(event.action.id, event.action);
    const { coordinates } = event.action;
    this.#pool.register(
      event.action.id,
      coordinates === undefined
        ? undefined
        : {
            deviceId: event.action.device.id,
            row: coordinates.row,
            column: coordinates.column,
          },
    );
    this.#pool.reconcile(this.#snapshot.resources);
    this.renderAll();
  }

  override onWillDisappear(event: WillDisappearEvent): void {
    this.#visibleActions.delete(event.action.id);
    this.#pool.unregister(event.action.id);
    this.#pool.reconcile(this.#snapshot.resources);
    this.renderAll();
  }

  override async onKeyDown(event: KeyDownEvent): Promise<void> {
    if (!event.action.isKey()) {
      return;
    }

    try {
      await this.#client.advanceDemo();
      await event.action.showOk();
    } catch {
      await event.action.showAlert();
    }
  }

  private renderAll(): void {
    const resources = new Map(
      this.#snapshot.resources.map((resource) => [resource.id, resource]),
    );

    for (const [slotId, visibleAction] of this.#visibleActions) {
      const resourceId = this.#pool.assignmentFor(slotId);
      const image = renderKeyImage(
        this.#snapshot.connection,
        resourceId === undefined ? undefined : resources.get(resourceId),
      );
      void visibleAction.setImage(image).catch(() => {
        // The action may disappear while an asynchronous render is in flight.
      });
    }
  }
}
