import { z } from "zod";

export const HUB_PROTOCOL_VERSION = 1;

export const HubMessageTypeSchema = z.enum([
  "event",
  "cmd",
  "rpc_req",
  "rpc_res",
  "state_patch",
  "presence",
  "error"
]);

export type HubMessageType = z.infer<typeof HubMessageTypeSchema>;

export const HubSourceSchema = z.object({
  clientId: z.string().min(1),
  serviceName: z.string().min(1).optional()
});

export const HubTargetSchema = z.union([
  z.literal("*"),
  z
    .object({
      clientId: z.string().min(1).optional(),
      serviceName: z.string().min(1).optional()
    })
    .refine((value) => Boolean(value.clientId || value.serviceName), {
      message: "target must include clientId or serviceName"
    })
]);

export type HubTarget = z.infer<typeof HubTargetSchema>;

export const HubEnvelopeSchema = z.object({
  v: z.number().int().positive(),
  id: z.string().min(1),
  type: HubMessageTypeSchema,
  name: z.string().min(1),
  source: HubSourceSchema,
  target: HubTargetSchema,
  ts: z.number().int().nonnegative(),
  correlationId: z.string().min(1).optional(),
  schemaVersion: z.number().int().positive(),
  payload: z.unknown(),
  meta: z
    .object({
      priority: z.enum(["low", "normal", "high"]).optional(),
      ttlMs: z.number().int().positive().optional(),
      trace: z.record(z.unknown()).optional()
    })
    .optional()
});

export type HubEnvelope = z.infer<typeof HubEnvelopeSchema>;

export const PresencePayloadSchema = z.object({
  clientId: z.string().min(1),
  serviceName: z.string().min(1).optional(),
  version: z.string().default("0.0.0"),
  provides: z.array(z.string().min(1)).default([]),
  consumes: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([])
});

export type PresencePayload = z.infer<typeof PresencePayloadSchema>;

export const SubscribePayloadSchema = z
  .object({
    names: z.array(z.string().min(1)).optional(),
    namePrefix: z.string().min(1).optional()
  })
  .refine((value) => Boolean(value.names?.length || value.namePrefix), {
    message: "subscribe requires names[] or namePrefix"
  });

export type SubscribePayload = z.infer<typeof SubscribePayloadSchema>;

export const RpcErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
});

export type RpcErrorShape = z.infer<typeof RpcErrorSchema>;

export const RpcRequestPayloadSchema = z.object({
  method: z.string().min(1),
  args: z.unknown(),
  timeoutMs: z.number().int().positive().max(120000).default(15000)
});

export type RpcRequestPayload = z.infer<typeof RpcRequestPayloadSchema>;

export const RpcResponsePayloadSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: RpcErrorSchema.optional()
});

export type RpcResponsePayload = z.infer<typeof RpcResponsePayloadSchema>;

export const StateSetPayloadSchema = z.object({
  path: z.string().min(1),
  value: z.unknown()
});

export type StateSetPayload = z.infer<typeof StateSetPayloadSchema>;

export const JsonPatchOpSchema = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string().min(1),
  from: z.string().min(1).optional(),
  value: z.unknown().optional()
});

export type JsonPatchOp = z.infer<typeof JsonPatchOpSchema>;

export const StatePatchPayloadSchema = z.object({
  path: z.string().min(1),
  patch: z.array(JsonPatchOpSchema).min(1)
});

export type StatePatchPayload = z.infer<typeof StatePatchPayloadSchema>;

export type ContractValidationMode = "reject" | "warn";

export interface ContractValidationResult {
  ok: boolean;
  issues?: string[];
}

interface RegisteredSchema {
  schemaVersion: number;
  schema: z.ZodTypeAny;
}

export class ContractRegistry {
  private readonly byName = new Map<string, Map<number, z.ZodTypeAny>>();

  register(name: string, schemaVersion: number, schema: z.ZodTypeAny): void {
    if (!this.byName.has(name)) {
      this.byName.set(name, new Map<number, z.ZodTypeAny>());
    }
    this.byName.get(name)!.set(schemaVersion, schema);
  }

  has(name: string, schemaVersion: number): boolean {
    return Boolean(this.byName.get(name)?.has(schemaVersion));
  }

  list(): RegisteredSchema[] {
    const items: RegisteredSchema[] = [];
    for (const [, versions] of this.byName.entries()) {
      for (const [schemaVersion, schema] of versions.entries()) {
        items.push({ schemaVersion, schema });
      }
    }
    return items;
  }

  validate(name: string, schemaVersion: number, payload: unknown): ContractValidationResult {
    const schema = this.byName.get(name)?.get(schemaVersion);
    if (!schema) {
      return { ok: true };
    }

    const parsed = schema.safeParse(payload);
    if (parsed.success) {
      return { ok: true };
    }

    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.length ? issue.path.join(".") : "payload";
        return `${path}: ${issue.message}`;
      })
    };
  }
}

export interface HubErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export function hubError(code: string, message: string, details?: unknown): HubErrorShape {
  return { code, message, details };
}

export function isHubEnvelope(value: unknown): value is HubEnvelope {
  return HubEnvelopeSchema.safeParse(value).success;
}

export function createDefaultContractRegistry(): ContractRegistry {
  const registry = new ContractRegistry();

  registry.register(
    "music.play",
    1,
    z.object({
      trackId: z.string().min(1),
      positionMs: z.number().int().nonnegative().optional()
    })
  );

  registry.register(
    "notes.updated",
    1,
    z.object({
      noteId: z.string().min(1),
      updatedAt: z.number().int().positive()
    })
  );

  registry.register(
    "state.patch",
    1,
    StatePatchPayloadSchema
  );

  return registry;
}

export function nowEpochMs(): number {
  return Date.now();
}

export function randomId(): string {
  const maybeCrypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (maybeCrypto?.randomUUID) {
    return maybeCrypto.randomUUID();
  }

  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function normalizeRpcError(error: unknown): RpcErrorShape {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        details: candidate.details
      };
    }
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown error"
  };
}
