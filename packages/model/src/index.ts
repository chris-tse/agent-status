import { z } from "zod";

const IdSchema = z.string().trim().min(1);

export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

export const ProviderIdSchema = IdSchema;
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ResourceIdSchema = IdSchema;
export type ResourceId = z.infer<typeof ResourceIdSchema>;

export const EventIdSchema = IdSchema;
export type EventId = z.infer<typeof EventIdSchema>;

export const ProviderConnectivitySchema = z.enum([
  "connected",
  "connecting",
  "degraded",
  "disconnected",
]);
export type ProviderConnectivity = z.infer<
  typeof ProviderConnectivitySchema
>;

export const ProviderStatusSchema = z.object({
  id: ProviderIdSchema,
  connectivity: ProviderConnectivitySchema,
  checkedAt: TimestampSchema,
  label: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1).optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const AgentLifecycleStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
]);
export type AgentLifecycleStatus = z.infer<
  typeof AgentLifecycleStatusSchema
>;

export const AgentResourceSchema = z
  .object({
    kind: z.literal("agent"),
    id: ResourceIdSchema,
    providerId: ProviderIdSchema,
    workspaceId: IdSchema.optional(),
    label: z.string().trim().min(1).optional(),
    status: AgentLifecycleStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    attentionReason: z.string().trim().min(1).optional(),
  })
  .superRefine((resource, context) => {
    const createdAt = Date.parse(resource.createdAt);
    const updatedAt = Date.parse(resource.updatedAt);

    if (updatedAt < createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must not be before createdAt",
      });
    }

    if (
      resource.startedAt !== undefined &&
      Date.parse(resource.startedAt) < createdAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "startedAt must not be before createdAt",
      });
    }

    if (
      resource.completedAt !== undefined &&
      Date.parse(resource.completedAt) <
        Date.parse(resource.startedAt ?? resource.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "completedAt must not be before the resource started",
      });
    }
  });
export type AgentResource = z.infer<typeof AgentResourceSchema>;

// The union has one prototype resource today and can grow by adding new kinds.
export const StatefulResourceSchema = AgentResourceSchema;
export type StatefulResource = z.infer<typeof StatefulResourceSchema>;

export const StatusEventSeveritySchema = z.enum([
  "info",
  "success",
  "warning",
  "error",
]);
export type StatusEventSeverity = z.infer<
  typeof StatusEventSeveritySchema
>;

export const StatusEventSchema = z
  .object({
    id: EventIdSchema,
    type: z.string().trim().min(1),
    severity: StatusEventSeveritySchema,
    message: z.string().trim().min(1),
    occurredAt: TimestampSchema,
    expiresAt: TimestampSchema.optional(),
    providerId: ProviderIdSchema.optional(),
    resourceId: ResourceIdSchema.optional(),
  })
  .superRefine((event, context) => {
    if (
      event.expiresAt !== undefined &&
      Date.parse(event.expiresAt) < Date.parse(event.occurredAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must not be before occurredAt",
      });
    }
  });
export type StatusEvent = z.infer<typeof StatusEventSchema>;

export const DashboardSnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  generatedAt: TimestampSchema,
  providers: z.array(ProviderStatusSchema),
  resources: z.array(StatefulResourceSchema),
  events: z.array(StatusEventSchema),
});
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;

export const DashboardChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("provider.upsert"),
    provider: ProviderStatusSchema,
  }),
  z.object({
    type: z.literal("provider.remove"),
    providerId: ProviderIdSchema,
  }),
  z.object({
    type: z.literal("resource.upsert"),
    resource: StatefulResourceSchema,
  }),
  z.object({
    type: z.literal("resource.remove"),
    resourceId: ResourceIdSchema,
  }),
  z.object({
    type: z.literal("event.upsert"),
    event: StatusEventSchema,
  }),
  z.object({
    type: z.literal("event.remove"),
    eventId: EventIdSchema,
  }),
]);
export type DashboardChange = z.infer<typeof DashboardChangeSchema>;

export const DashboardSnapshotMessageSchema = z.object({
  type: z.literal("snapshot"),
  snapshot: DashboardSnapshotSchema,
});
export type DashboardSnapshotMessage = z.infer<
  typeof DashboardSnapshotMessageSchema
>;

export const DashboardUpdateMessageSchema = z.object({
  type: z.literal("update"),
  version: z.number().int().nonnegative(),
  generatedAt: TimestampSchema,
  changes: z.array(DashboardChangeSchema).min(1),
});
export type DashboardUpdateMessage = z.infer<
  typeof DashboardUpdateMessageSchema
>;

export const DashboardResetMessageSchema = z.object({
  type: z.literal("reset"),
  generatedAt: TimestampSchema,
  reason: z.string().trim().min(1).optional(),
});
export type DashboardResetMessage = z.infer<
  typeof DashboardResetMessageSchema
>;

export const DashboardWireMessageSchema = z.discriminatedUnion("type", [
  DashboardSnapshotMessageSchema,
  DashboardUpdateMessageSchema,
  DashboardResetMessageSchema,
]);
export type DashboardWireMessage = z.infer<
  typeof DashboardWireMessageSchema
>;

export const StatusClassificationSchema = z.enum([
  "active",
  "attention",
  "success",
  "error",
]);
export type StatusClassification = z.infer<
  typeof StatusClassificationSchema
>;

const statusClassifications = {
  running: "active",
  waiting: "attention",
  completed: "success",
  failed: "error",
} as const satisfies Record<AgentLifecycleStatus, StatusClassification>;

export function classifyAgentStatus(
  status: AgentLifecycleStatus,
): StatusClassification {
  return statusClassifications[status];
}
