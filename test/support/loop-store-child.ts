import { FileLoopStateStore } from "../../src/loop/store.js";

const [statePath, eventId, delayArgument] = process.argv.slice(2);
if (statePath === undefined || eventId === undefined || delayArgument === undefined) {
  throw new Error("loop-store-child-arguments-missing");
}
const delayMs = Number(delayArgument);
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
  throw new Error("loop-store-child-delay-invalid");
}

const store = new FileLoopStateStore(statePath);
await store.update(async (state) => {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  state.maintenanceAudit.push({
    at: "2026-07-23T12:00:00.000Z",
    eventId,
    removedAttempts: 0,
    result: "success",
  });
});
