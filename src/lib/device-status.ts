// Mirrors the web app's device states (frontend/lib/device-status-utils.ts in
// labric/web), where an online device that is not watching a folder is a
// warning. `isWatching` must come from the backend's watched folder, the same
// value the heartbeat reports as `is_watching`.
export function deviceStatusDisplay(
  serverStatus: string | undefined,
  isWatching: boolean
) {
  if (serverStatus !== "online") {
    return { label: "Offline", dotClass: "bg-destructive" };
  }
  if (!isWatching) {
    return {
      label: "Connected, but not watching a folder",
      dotClass: "bg-warning",
    };
  }
  return { label: "Online", dotClass: "bg-success" };
}
