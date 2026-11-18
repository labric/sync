// Mirrors the web app's device status badge (frontend/components/
// current-device-status.tsx in labric/web). `isWatching` must come from the
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
      tooltip: "Device is online, but not watching a folder",
    };
  }
  return { label: "Online", dotClass: "bg-success" };
}
