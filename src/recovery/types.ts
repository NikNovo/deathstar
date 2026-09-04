export interface RecoveryMapping {
  version: 1;
  herdrSession: string;
  paneId: string;
  ompPid: number;
  processStartedAt: string | null;
  sessionFile: string;
  sessionRoot: string;
  cwd: string | null;
  capturedAt: string;
  fileSize: number;
  fileMtimeMs: number;
}

export type RecoveryState = "open" | "closed" | "missing" | "inconsistent";

export interface RecoveryStatus {
  state: RecoveryState;
  mapping: RecoveryMapping | null;
  mappingExists: boolean;
  sessionExists: boolean;
  currentOmpPid: number | null;
  currentSessionFile: string | null;
  error: string | null;
}

export interface RecoveryCommand {
  command: "bind" | "status" | "close" | "open";
  name: string;
  noAttach: boolean;
  json: boolean;
}
