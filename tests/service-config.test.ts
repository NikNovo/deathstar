import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const unitPath = new URL("../ops/deathstar.service", import.meta.url);

test("deathstar user service is loopback-only and restartable", () => {
  const unit = readFileSync(unitPath, "utf8");

  expect(unit).toContain("WorkingDirectory=%h/deathstar");
  expect(unit).toContain("ExecStart=/usr/bin/env bun %h/deathstar/src/server.ts");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("Environment=DEATHSTAR_HOST=127.0.0.1");
  expect(unit).toContain("Environment=DEATHSTAR_PORT=3848");
  expect(unit).toContain("Environment=DEATHSTAR_AUTO_CLEANUP=off");
  expect(unit).not.toContain(["/home", "dev"].join("/"));
  expect(unit).not.toContain("tailnet");
  expect(unit).not.toMatch(/^ExecStop=/m);
  expect(unit).not.toMatch(/^ExecStart=.*\b(kill|stop|delete)\b/im);
});
