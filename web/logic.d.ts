export declare function formatDateValue(value: string | null | undefined): string;
export declare function formatAgeValue(value: string | null | undefined, nowMs?: number): string;
export declare function resourceStatus(
  used: number | null | undefined,
  total: number | null | undefined,
  warningThreshold: number,
): "ok" | "warning" | "critical" | "unknown";
export declare function parseCleanupResult(
  body: unknown,
  responseOk: boolean,
  responseStatus: number,
): {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
};
export declare function chartValue(value: number | null | undefined, divisor?: number): number | null;
export declare function catalogState(catalog: { status?: string } | null | undefined): "ok" | "warning" | "critical" | "unknown";
