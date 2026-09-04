import { expect, test } from "bun:test";
import {
  DEMO_OBSERVED_AT,
  createDemoEvents,
  createDemoMaintenance,
  createDemoSnapshot,
  createDemoUsage,
} from "../scripts/demo-data.ts";

test("demo fixtures stay synthetic across all dashboard states", () => {
  for (const state of ["healthy", "pressure", "unavailable"] as const) {
    const payload = JSON.stringify({
      snapshot: createDemoSnapshot(state),
      events: createDemoEvents(state),
      usage: createDemoUsage(state),
      maintenance: createDemoMaintenance(state),
    });
    expect(payload).not.toMatch(/\/home\/|tailnet|token|transcript|@mail|\.jsonl/iu);
  }

  expect(createDemoSnapshot("unavailable").collectorErrors).toEqual(["Herdr integration unavailable"]);
  expect(createDemoSnapshot("pressure").host.state).toBe("critical");
  expect(createDemoMaintenance("unavailable").authorization).toBe("helper-missing");
  expect(createDemoUsage("unavailable").status).toBe("unknown");
  expect(DEMO_OBSERVED_AT).toBe("2026-01-15T12:00:00.000Z");
});
