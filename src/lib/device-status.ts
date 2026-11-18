// Colours and labels follow the web app's device status badge
// (frontend/components/current-device-status.tsx in labric/web); the
// not-watching tooltip is Sync's own wording. `isWatching` must come from the
// backend's watched folder, the same value the heartbeat reports as
// `is_watching`.
export function deviceStatusDisplay(
  serverStatus: string | undefined,
  isWatching: boolean
): { label: string; dotClass: string; tooltip?: string } {
  if (serverStatus !== "online") {
    return { label: "Offline", dotClass: "bg-destructive" };
  }
  if (!isWatching) {
    return {
      label: "Not watching a folder",
      dotClass: "bg-warning",
      tooltip: "Online, not watching a folder",
    };
  }
  return { label: "Online", dotClass: "bg-success" };
}

// Files can still be uploading after watching stops, so pending uploads are
// shown either way; "up to date" only means something for a watched folder.
export function syncProgressDisplay(
  pending: number,
  isWatching: boolean
): { kind: "syncing"; pending: number } | { kind: "up_to_date" } | null {
  if (pending > 0) return { kind: "syncing", pending };
  return isWatching ? { kind: "up_to_date" } : null;
}
