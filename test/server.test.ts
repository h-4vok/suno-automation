import { afterEach, describe, expect, it } from "vitest";

import { Coordinator } from "../src/coordinator/coordinator.js";
import { InMemoryStateStore } from "../src/persistence/state.js";
import { buildServer } from "../src/server/app.js";
import { makeConfig, SequenceRandom } from "./support/fixtures.js";

const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

function server() {
  const app = buildServer({
    coordinator: new Coordinator({
      clock: { now: () => new Date("2026-07-19T22:30:00.000Z") },
      config: makeConfig(),
      random: new SequenceRandom(0, 0),
      songwriter: {
        compose: () => Promise.resolve({ lyricsField: "[Intro: strings]", title: "Test" }),
      },
      store: new InMemoryStateStore(),
    }),
    token: "correct-secret",
  });
  servers.push(app);
  return app;
}

describe("local API", () => {
  it("keeps health public but protects state and mutations", async () => {
    const app = server();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          headers: { authorization: "Bearer wrong-secret" },
          method: "POST",
          payload: { reason: "manual" },
          url: "/api/v1/runs",
        })
      ).statusCode,
    ).toBe(401);
  });

  it("queues and leases an inspect command with valid auth", async () => {
    const app = server();
    const headers = { authorization: "Bearer correct-secret" };
    expect(
      (await app.inject({ headers, method: "POST", payload: {}, url: "/api/v1/runs" })).statusCode,
    ).toBe(202);
    const lease = await app.inject({
      headers,
      method: "GET",
      url: "/api/v1/extension/commands/next",
    });
    expect(lease.statusCode).toBe(200);
    expect(lease.json()).toMatchObject({ command: { kind: "inspect" } });
    expect(
      (await app.inject({ headers, method: "GET", url: "/api/v1/extension/commands/next" }))
        .statusCode,
    ).toBe(204);
  });

  it("rejects malformed extension results before domain handling", async () => {
    const app = server();
    const response = await app.inject({
      headers: { authorization: "Bearer correct-secret" },
      method: "POST",
      payload: { kind: "inspect", quota: { state: "invented" } },
      url: "/api/v1/extension/commands/00000000-0000-4000-8000-000000000000/result",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });
});
