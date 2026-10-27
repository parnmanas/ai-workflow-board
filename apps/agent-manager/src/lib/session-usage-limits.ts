/** Provider quota snapshots, distinct from token usage and model context size. */
export interface SessionUsageLimits {
  limit_id: string;
  limit_name?: string;
  observed_at: string;
  windows: Array<{
    id: string;
    used_percent: number;
    window_minutes: number | null;
    resets_at: string | null;
  }>;
}
