import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { CommandResultSchema } from "../contracts/extension.js";
import type { Coordinator } from "../coordinator/coordinator.js";
import { hasBearerToken } from "./auth.js";

const StartRunSchema = z.object({
  force: z.boolean().optional(),
  reason: z.enum(["manual", "schedule"]).default("manual"),
});

const CommandParametersSchema = z.object({ id: z.uuid() });

export function buildServer(options: {
  coordinator: Coordinator;
  logger?: boolean;
  token: string;
}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });

  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }
    if (!hasBearerToken(request.headers.authorization, options.token)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  server.get("/health", () => ({ status: "ok" }));

  server.get("/api/v1/status", async () => options.coordinator.state());

  server.post("/api/v1/runs", async (request, reply) => {
    const input = StartRunSchema.parse(request.body ?? {});
    const run = await options.coordinator.startRun({
      ...(input.force === undefined ? {} : { force: input.force }),
      reason: input.reason,
    });
    return reply.code(202).send({ run });
  });

  server.get("/api/v1/extension/commands/next", async (_request, reply) => {
    const command = await options.coordinator.leaseNextCommand();
    if (command === undefined) {
      return reply.code(204).send();
    }
    return { command };
  });

  server.post("/api/v1/extension/commands/:id/result", async (request, reply) => {
    const { id } = CommandParametersSchema.parse(request.params);
    const result = CommandResultSchema.parse(request.body);
    await options.coordinator.completeCommand(id, result);
    return reply.code(202).send({ accepted: true });
  });

  server.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", issues: error.issues });
    }
    server.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  return server;
}
