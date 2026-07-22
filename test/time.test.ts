import { describe, expect, it } from "vitest";

import { dayInTimezone } from "../src/domain/time.js";

describe("dayInTimezone", () => {
  it("changes day at London midnight in winter", () => {
    expect(dayInTimezone(new Date("2025-12-31T23:59:59.000Z"), "Europe/London")).toBe("2025-12-31");
    expect(dayInTimezone(new Date("2026-01-01T00:00:00.000Z"), "Europe/London")).toBe("2026-01-01");
  });

  it("uses the daylight-saving offset at London midnight in summer", () => {
    expect(dayInTimezone(new Date("2026-07-19T22:59:59.000Z"), "Europe/London")).toBe("2026-07-19");
    expect(dayInTimezone(new Date("2026-07-19T23:00:00.000Z"), "Europe/London")).toBe("2026-07-20");
  });
});
