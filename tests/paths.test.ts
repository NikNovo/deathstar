import { expect, test } from "bun:test";
import { homeDirectory, ompSessionRoot, recoveryDirectory, stateDirectory } from "../src/paths.ts";

test("derives Deathstar state and integration roots from XDG and HOME", () => {
  const env = { HOME: "/synthetic/home", XDG_STATE_HOME: undefined };

  expect(homeDirectory(env)).toBe("/synthetic/home");
  expect(stateDirectory(env)).toBe("/synthetic/home/.local/state/deathstar");
  expect(recoveryDirectory(env)).toBe("/synthetic/home/.local/state/deathstar/recovery");
  expect(ompSessionRoot(env)).toBe("/synthetic/home/.omp/agent/sessions");
  expect(stateDirectory({ HOME: "/synthetic/home", XDG_STATE_HOME: "/synthetic/state" }))
    .toBe("/synthetic/state/deathstar");
});

test("rejects relative HOME and XDG state roots", () => {
  expect(() => homeDirectory({ HOME: "relative" })).toThrow("HOME");
  expect(() => stateDirectory({ HOME: "/synthetic/home", XDG_STATE_HOME: "relative" })).toThrow("XDG_STATE_HOME");
});
