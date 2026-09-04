import { useMutation } from '@tanstack/react-query';

export interface BackupManifest {
  app: string;
  dbVersion: number;
  createdAt: string;
  counts: {
    devices: number;
    scenes: number;
    pixelScenes: number;
    mediaAssets: number;
    hasFloorplan: boolean;
  };
}

/** Fetch the backup zip and hand it to the browser as a download. */
export async function downloadBackup(): Promise<void> {
  const res = await fetch('/api/system/backup');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `Backup failed (HTTP ${res.status})`;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'ewc-backup.zip';

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function useRestoreBackup() {
  return useMutation({
    mutationFn: async (file: File): Promise<BackupManifest> => {
      const res = await fetch('/api/system/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: file,
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      if (!res.ok) {
        const message =
          (data as { error?: { message?: string } } | undefined)?.error?.message ??
          `Restore failed (HTTP ${res.status})`;
        throw new Error(message);
      }
      return (data as { manifest: BackupManifest }).manifest;
    },
  });
}

/** Current server uptime in seconds, or `null` if it can't be read. */
export async function serverUptime(): Promise<number | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { uptime?: number };
    return typeof data.uptime === 'number' ? data.uptime : null;
  } catch {
    return null;
  }
}

/**
 * Wait for the server to come back as a *new* process after a restore. Polling
 * `/api/health` naively would accept the still-dying old process (it answers for
 * ~250 ms after sending the restore response) and reload into a dead port. So we
 * accept a health response only once it proves a restart happened: either we saw
 * the server go down in between, or its `uptime` is now below what it was before
 * the restore. Resolves `true` when it's back, `false` on timeout.
 */
export async function waitForRestart(
  baselineUptimeS: number | null,
  timeoutMs = 30_000,
): Promise<boolean> {
  const baseline = baselineUptimeS ?? Number.POSITIVE_INFINITY;
  const deadline = Date.now() + timeoutMs;
  let sawDown = false;
  // Let the old process finish exiting before the first probe.
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { uptime?: number };
        const up = typeof data.uptime === 'number' ? data.uptime : Number.POSITIVE_INFINITY;
        if (sawDown || up < baseline) return true;
      } else {
        sawDown = true;
      }
    } catch {
      sawDown = true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
