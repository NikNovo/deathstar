import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const installerPath = new URL("../ops/install-memory-cleanup", import.meta.url);
const servicePath = new URL("../ops/deathstar.service", import.meta.url);

test("installer validates sudoers before installing the privileged helper", () => {
  const script = readFileSync(installerPath, "utf8");
  expect(script).toContain("sudo -v");
  expect(script).toContain("sudo visudo -cf");
  expect(script).toContain("deathstar-memory-clean.sudoers");
  expect(script).not.toContain("sudo -S");

  expect(script).toContain("id -un");
  expect(script).toContain("sudoers_rendered");
});

test("service contains explicit cleanup and safe policy settings", () => {
  const unit = readFileSync(servicePath, "utf8");
  expect(unit).toContain("Environment=DEATHSTAR_MEMORY_HELPER=/usr/local/libexec/deathstar-memory-clean");
  expect(unit).toContain("Environment=DEATHSTAR_MEMORY_TIMEOUT_MS=30000");
  expect(unit).toContain("Environment=DEATHSTAR_MEMORY_COOLDOWN_MS=60000");
  expect(unit).toContain("Environment=DEATHSTAR_AUTO_CLEANUP=off");
  expect(unit).toContain("Environment=DEATHSTAR_AUTO_CLEANUP_COOLDOWN_MS=600000");
  expect(unit).not.toContain(["/home", "dev"].join("/"));
  expect(unit).not.toContain("tailnet");
});
