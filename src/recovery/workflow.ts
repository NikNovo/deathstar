import { basename, isAbsolute, relative, resolve } from "node:path";
import { createCommandRunner } from "../command.ts";
import { createHerdrControl, type HerdrControl, type HerdrPane } from "./herdr-control.ts";
import { createMappingStore, type MappingStore, validateSessionName } from "./mapping.ts";
import { createProcessFiles, type ProcessFiles } from "./process-files.ts";
import type { RecoveryMapping, RecoveryStatus } from "./types.ts";
import { ompSessionRoot } from "../paths.ts";

export interface RecoveryWorkflowOptions {
  mappingStore?: MappingStore;
  processFiles?: ProcessFiles;
  herdrControl?: HerdrControl;
  isTTY?: boolean;
  sessionRoot?: string;
  now?: () => Date;
}

export interface RecoveryWorkflow {
  bind(name: string): Promise<RecoveryMapping>;
  status(name: string): Promise<RecoveryStatus>;
  close(name: string): Promise<RecoveryStatus>;
  open(name: string, options: { noAttach: boolean }): Promise<RecoveryStatus>;
}

function isOmpCommand(command: string): boolean {
  return command.split(/\s+/).some((part) => part === "omp" || part.endsWith("/omp"));
}

function isMappedSessionFile(sessionFile: string, sessionRoot: string): boolean {
  if (!isAbsolute(sessionFile)) return false;
  const root = resolve(sessionRoot);
  const candidate = resolve(sessionFile);
  const relativePath = relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath) && candidate.endsWith(".jsonl") && basename(candidate) !== "__advisor.jsonl";
}

export function createRecoveryWorkflow(options: RecoveryWorkflowOptions = {}): RecoveryWorkflow {
  const processFiles = options.processFiles || createProcessFiles();
  const sessionRoot = options.sessionRoot || process.env.DEATHSTAR_SESSION_ROOT || ompSessionRoot();
  const mappingStore = options.mappingStore || createMappingStore();
  const interactive = options.isTTY ?? process.stdout.isTTY === true;
  const herdrControl = options.herdrControl || createHerdrControl({
    runner: createCommandRunner(),
    processFiles,
    sessionRoot,
  });
  const now = options.now || (() => new Date());
  async function exactSessionFile(pid: number, allowResumeArgv: boolean, expectedSessionFile?: string): Promise<string> {
    const resumed = allowResumeArgv ? await processFiles.resumeSessionFile(pid, sessionRoot) : null;
    if (resumed) return resumed;
    try {
      const files = await processFiles.findPrimarySessionFiles(pid, sessionRoot, expectedSessionFile);
      return files[0]!;
    } catch (error) {
      if (!allowResumeArgv || !(error instanceof Error && (error.message.startsWith("no primary JSONL session file") || error.message.startsWith("ambiguous primary JSONL session files")))) throw error;
      const fallback = await processFiles.resumeSessionFile(pid, sessionRoot);
      if (fallback) return fallback;
      throw error;
    }
  }

  async function currentOmp(name: string, allowResumeArgv = false, paneId?: string, expectedSessionFile?: string): Promise<{ pane: HerdrPane; pid: number; sessionFile: string; processStartedAt: string | null } | null> {
    const panes = paneId ? [await herdrControl.currentPane(name, paneId)] : await herdrControl.listPanes(name);
    const candidates: Array<{ pane: HerdrPane; pid: number; command: string }> = [];
    for (const pane of panes) {
      for (const pid of pane.foregroundPids) {
        try {
          const command = await processFiles.processCommand(pid);
          if (isOmpCommand(command)) candidates.push({ pane, pid, command });
        } catch {
          // A process can disappear between process-info and /proc reads.
        }
      }
    }
    if (candidates.length === 0) return null;
    if (candidates.length > 1) throw new Error(`multiple OMP processes in Herdr session ${name}`);
    const candidate = candidates[0]!;
    const sessionFile = await exactSessionFile(candidate.pid, allowResumeArgv, expectedSessionFile);
    return {
      pane: candidate.pane,
      pid: candidate.pid,
      sessionFile,
      processStartedAt: await processFiles.readProcessStartTime(candidate.pid),
    };
  }

  async function herdrSessionExists(name: string): Promise<boolean> {
    try {
      await herdrControl.sessionSnapshot(name);
      return true;
    } catch {
      return false;
    }
  }
  async function mappingStatus(name: string, mapping: RecoveryMapping, paneId = mapping.paneId): Promise<RecoveryStatus> {
    if (!isMappedSessionFile(mapping.sessionFile, sessionRoot)) {
      return { state: "missing", mapping, mappingExists: true, sessionExists: await herdrSessionExists(name), currentOmpPid: null, currentSessionFile: null, error: "mapped session file is outside the configured OMP session root" };
    }
    try {
      await processFiles.fileMetadata(mapping.sessionFile);
    } catch {
      return { state: "missing", mapping, mappingExists: true, sessionExists: await herdrSessionExists(name), currentOmpPid: null, currentSessionFile: null, error: "mapped session file is unavailable" };
    }
    try {
      const current = await currentOmp(name, true, paneId, mapping.sessionFile);
      if (!current) {
        const pane = await herdrControl.currentPane(name);
        return { state: "closed", mapping, mappingExists: true, sessionExists: true, currentOmpPid: null, currentSessionFile: null, error: null };
      }
      const matches = current.sessionFile === mapping.sessionFile;
      const resolvedMapping = paneId === mapping.paneId ? mapping : { ...mapping, paneId };
      return {
        state: matches ? "open" : "inconsistent",
        mapping: resolvedMapping,
        mappingExists: true,
        sessionExists: true,
        currentOmpPid: current.pid,
        currentSessionFile: current.sessionFile,
        error: matches ? null : "current pane OMP does not match the saved mapping",
      };
    } catch (error) {
      const sessionExists = await herdrSessionExists(name);
      return {
        state: "closed",
        mapping,
        mappingExists: true,
        sessionExists,
        currentOmpPid: null,
        currentSessionFile: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function openPane(name: string, mappedPaneId: string): Promise<HerdrPane> {
    try {
      return await herdrControl.currentPane(name, mappedPaneId);
    } catch (error) {
      let panes: HerdrPane[];
      try {
        panes = await herdrControl.listPanes(name);
      } catch {
        throw error;
      }
      if (panes.length !== 1) throw error;
      return panes[0]!;
    }
  }

  async function adoptRestored(name: string, mapping: RecoveryMapping, status: RecoveryStatus, options: { noAttach: boolean }): Promise<RecoveryStatus> {
    if (status.currentOmpPid === null) throw new Error(`refusing to open ${name}: restored OMP has no PID`);
    const restoredPane = await herdrControl.currentPane(name, mapping.paneId);
    const metadata = await processFiles.fileMetadata(mapping.sessionFile);
    const updatedMapping: RecoveryMapping = {
      ...mapping,
      paneId: restoredPane.paneId,
      ompPid: status.currentOmpPid,
      processStartedAt: await processFiles.readProcessStartTime(status.currentOmpPid),
      cwd: await processFiles.processCwd(status.currentOmpPid),
      capturedAt: now().toISOString(),
      fileSize: metadata.size,
      fileMtimeMs: metadata.mtimeMs,
    };
    mappingStore.write(updatedMapping);
    if (!options.noAttach && interactive) await herdrControl.attach(name);
    return { ...status, mapping: updatedMapping };
  }

  return {
    async bind(name) {
      validateSessionName(name);
      const current = await currentOmp(name, true);
      if (!current) throw new Error(`Herdr session ${name} has no active OMP`);
      const metadata = await processFiles.fileMetadata(current.sessionFile);
      const mapping: RecoveryMapping = {
        version: 1,
        herdrSession: name,
        paneId: current.pane.paneId,
        ompPid: current.pid,
        processStartedAt: current.processStartedAt,
        sessionFile: current.sessionFile,
        sessionRoot,
        cwd: await processFiles.processCwd(current.pid),
        capturedAt: now().toISOString(),
        fileSize: metadata.size,
        fileMtimeMs: metadata.mtimeMs,
      };
      mappingStore.write(mapping);
      return mapping;
    },

    async status(name) {
      validateSessionName(name);
      const mapping = mappingStore.read(name);
      if (!mapping) {
        let sessionExists = false;
        try {
          await herdrControl.currentPane(name);
          sessionExists = true;
        } catch {
          sessionExists = false;
        }
        return { state: "missing", mapping: null, mappingExists: false, sessionExists, currentOmpPid: null, currentSessionFile: null, error: "no recovery mapping" };
      }
      return mappingStatus(name, mapping);
    },

    async close(name) {
      const mapping = mappingStore.read(validateSessionName(name));
      if (!mapping) throw new Error(`no recovery mapping for ${name}; run bind first`);
      const status = await mappingStatus(name, mapping);
      if (status.state !== "open" || status.currentOmpPid === null) {
        throw new Error(`refusing to close ${name}: ${status.error || status.state}`);
      }
      const targetPid = status.currentOmpPid;
      const targetStart = await processFiles.readProcessStartTime(targetPid);
      if (mapping.ompPid !== targetPid || (mapping.processStartedAt !== null && mapping.processStartedAt !== targetStart)) {
        throw new Error(`refusing to close ${name}: mapped OMP identity changed`);
      }
      const pane = await herdrControl.currentPane(name, mapping.paneId);
      if (pane.paneId !== mapping.paneId || !pane.foregroundPids.includes(targetPid)) {
        throw new Error(`refusing to close ${name}: pane/PID changed`);
      }
      await herdrControl.sendExitKey(name, mapping.paneId);
      await herdrControl.waitForPidExit(targetPid, targetStart, 15_000);
      const metadata = await processFiles.fileMetadata(mapping.sessionFile);
      const updatedMapping = {
        ...mapping,
        ompPid: targetPid,
        processStartedAt: targetStart,
        capturedAt: now().toISOString(),
        fileSize: metadata.size,
        fileMtimeMs: metadata.mtimeMs,
      };
      mappingStore.write(updatedMapping);
      await herdrControl.stopSession(name);
      return { ...status, mapping: updatedMapping, state: "closed", currentOmpPid: null, currentSessionFile: null, sessionExists: false, error: null };
    },

    async open(name, options) {
      const mapping = mappingStore.read(validateSessionName(name));
      if (!mapping) throw new Error(`no recovery mapping for ${name}; run bind first`);
      if (!isMappedSessionFile(mapping.sessionFile, sessionRoot)) {
        throw new Error(`mapped session file is outside the configured OMP session root: ${mapping.sessionFile}`);
      }
      const fileMetadata = await processFiles.fileMetadata(mapping.sessionFile);
      if (fileMetadata.size < 0) throw new Error(`mapped session file is invalid: ${mapping.sessionFile}`);
      const before = await mappingStatus(name, mapping);
      if (before.state === "inconsistent") throw new Error(`refusing to open ${name}: ${before.error}`);
      if (before.state === "open") return adoptRestored(name, mapping, before, options);
      await herdrControl.ensureSession(name);
      const restored = await mappingStatus(name, mapping);
      if (restored.state === "inconsistent") throw new Error(`refusing to open ${name}: ${restored.error}`);
      if (restored.state === "open") return adoptRestored(name, mapping, restored, options);
      const pane = await openPane(name, mapping.paneId);
      for (const pid of pane.foregroundPids) {
        try {
          if (isOmpCommand(await processFiles.processCommand(pid))) {
            const raced = await mappingStatus(name, mapping, pane.paneId);
            if (raced.state === "open") return adoptRestored(name, raced.mapping || mapping, raced, options);
            throw new Error(`refusing to open ${name}: another OMP is already foreground`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("another OMP")) throw error;
        }
      }
      await herdrControl.runInPane(name, pane.paneId, "omp", ["--resume", mapping.sessionFile]);
      const newPid = await herdrControl.waitForMappedPid(name, mapping.sessionFile, 15_000, pane.paneId);
      const metadata = await processFiles.fileMetadata(mapping.sessionFile);
      mappingStore.write({
        ...mapping,
        paneId: pane.paneId,
        ompPid: newPid,
        processStartedAt: await processFiles.readProcessStartTime(newPid),
        cwd: await processFiles.processCwd(newPid),
        capturedAt: now().toISOString(),
        fileSize: metadata.size,
        fileMtimeMs: metadata.mtimeMs,
      });
      const after = await mappingStatus(name, mappingStore.read(name)!);
      if (!options.noAttach && interactive) await herdrControl.attach(name);
      return after;
    },
  };
}
