export interface DownloadTimeoutOverrides {
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
  minThroughputBytesPerSec?: number;
  throughputWindowMs?: number;
  onProgress?: (progress: { receivedBytes: number; totalBytes: number | null }) => void;
}

export function downloadToFileWithTimeout(
  url: string,
  destPath: string,
  init?: RequestInit,
  overrides?: DownloadTimeoutOverrides,
): Promise<{ size: number }>;
