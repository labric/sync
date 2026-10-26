import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Settings2Icon,
  // MoreVertical,
  // Copy,
  // FolderOpen,
  // RotateCcw,
  Clock,
  ListEnd,
  CheckCircle,
  XCircle,
  EyeOff,
  Folder,
  Loader2,
  CloudCheck,
  ArrowUp,
  Search,
  UserIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
// import {
//   DropdownMenu,
//   DropdownMenuContent,
//   DropdownMenuItem,
//   DropdownMenuSeparator,
//   DropdownMenuTrigger,
// } from "@/components/ui/dropdown-menu";

import { toast } from "sonner";
import { FileChangeEvent, FileUploadStatus } from "@/types";
import { useUploadManager } from "@/hooks/useUploadManager";
import { useSessionContext } from "@/hooks/use-session-context";
import { useAppVersion } from "@/hooks/useAppVersion";
import UploadSettingsSheet from "./UploadSettingsDialog";
import SessionContextSheet from "./session-context-dialog";
import { getRecentDirs, pushRecent } from "@/lib/store";

const statusConfig = {
  pending: {
    icon: Clock,
    tooltip: "Waiting for batched changes",
    className: "text-muted-foreground",
  },
  queued: {
    icon: ListEnd,
    tooltip: "Queued for upload",
    className: "text-muted-foreground",
  },
  uploading: {
    icon: Loader2,
    tooltip: "Currently uploading...",
    className: "text-muted-foreground animate-spin",
  },
  uploaded: {
    icon: CheckCircle,
    tooltip: "Successfully uploaded",
    className: "text-success",
  },
  failed: {
    icon: XCircle,
    tooltip: "Upload failed",
    className: "text-destructive",
  },
  ignored: {
    icon: EyeOff,
    tooltip: "Ignored (matches ignore pattern)",
    className: "text-muted-foreground",
  },
  directory: {
    icon: Folder,
    tooltip: "Directory",
    className: "text-muted-foreground",
  },
} as const;

function getRelativePathFromFolder(absolutePath: string, folder: string): string {
  if (!folder || !absolutePath.startsWith(folder)) return absolutePath;
  const relativePath = absolutePath.slice(folder.length);
  return relativePath.startsWith("/") || relativePath.startsWith("\\")
    ? relativePath.slice(1)
    : relativePath;
}

function truncatePath(path: string, maxLength: number = 35): string {
  if (path.length <= maxLength) return path;
  return "..." + path.slice(-(maxLength - 3));
}

function splitDirPath(dir: string): { name: string; parent: string } {
  const sep = dir.includes("\\") ? "\\" : "/";
  const parts = dir.replace(/[/\\]+$/, "").split(sep);
  const name = parts.pop() || dir;
  let parent = parts.join(sep);
  // Replace home directory with ~ (macOS/Linux: /Users|home/<name>, Windows: X:\Users\<name>)
  const ui = parts.indexOf("Users") !== -1 ? parts.indexOf("Users") : parts.indexOf("home");
  if (ui !== -1 && parts[ui + 1]) {
    parent = "~" + parent.slice(parts.slice(0, ui + 2).join(sep).length);
  }
  return { name, parent };
}

const FileChangeRow = memo(function FileChangeRow({
  change,
  status,
  selectedFolder,
}: {
  change: FileChangeEvent;
  status: FileUploadStatus["status"] | undefined;
  selectedFolder: string;
}) {
  const relativePath = getRelativePathFromFolder(change.path, selectedFolder);
  const StatusIcon = status ? statusConfig[status].icon : null;
  const statusMeta = status ? statusConfig[status] : null;

  return (
    <div className="flex items-center py-2 w-full">
      <div className="flex-1 min-w-0 pr-3">
        <p className="text-sm truncate" title={relativePath}>
          {truncatePath(relativePath)}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {StatusIcon && statusMeta && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex h-4 w-4 items-center justify-center">
                <StatusIcon className={`h-4 w-4 ${statusMeta.className}`} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{statusMeta.tooltip}</p>
            </TooltipContent>
          </Tooltip>
        )}
        <span className="text-xs text-muted-foreground whitespace-nowrap font-mono">
          {new Date(change.timestamp * 1000).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
});

export default function Simple() {
  const { progress } = useUploadManager();
  const { isActive: sessionActive, timeRemaining: sessionTimeRemaining } = useSessionContext();
  const appVersion = useAppVersion();
  const [selectedFolder, setSelectedFolder] = useState("");
  const [fileChanges, setFileChanges] = useState<FileChangeEvent[]>([]);
  // Removed isOnline state as it's no longer needed with Rust backend
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [heartbeatStatus, setHeartbeatStatus] = useState<any>(null);
  const [uploadStatuses, setUploadStatuses] = useState<
    Map<string, FileUploadStatus["status"]>
  >(new Map());
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const logsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Listen for file change events from Tauri
    const unlistenFileChange = listen("file_change", (event) => {
      console.log("file_change", event);
      const fileChange = event.payload as FileChangeEvent;
      setFileChanges((prev) => {
        // Remove any existing entries for this file path
        const filteredPrev = prev.filter(
          (change) => change.path !== fileChange.path
        );
        // Add the new change at the beginning (most recent)
        const updated = [fileChange, ...filteredPrev];
        // Keep only latest 500 changes
        return updated.slice(0, 500);
      });
    });

    // Listen for heartbeat status events from Rust backend
    const unlistenHeartbeat = listen("heartbeat_status", (event) => {
      console.log("heartbeat_status", event);
      setHeartbeatStatus(event.payload);
    });

    // The backend resumes watching on its own after a restart; reflect that
    // in the UI whether it finished before or after this component mounted
    const unlistenWatchResumed = listen("watch_resumed", (event) => {
      setSelectedFolder(event.payload as string);
    });
    const unlistenWatchResumeFailed = listen("watch_resume_failed", (event) => {
      setSelectedFolder("");
      toast.error(`Could not resume watching ${event.payload as string}`);
    });
    invoke<string | null>("get_watched_folder")
      .then((folder) => {
        if (folder) setSelectedFolder(folder);
      })
      .catch((err) => console.error("Failed to get watched folder:", err));

    // Listen for file upload status events
    const unlistenUploadStatus = listen("file_upload_status", (event) => {
      console.log("file_upload_status", event);
      const uploadStatus = event.payload as FileUploadStatus;
      setUploadStatuses((prev) => {
        const next = new Map(prev);
        next.set(uploadStatus.relative_path, uploadStatus.status);
        // Cap at 1000 entries to prevent unbounded memory growth
        if (next.size > 1000) {
          const firstKey = next.keys().next().value;
          if (firstKey !== undefined) next.delete(firstKey);
        }
        return next;
      });
    });

    // Events emitted before this component mounted (e.g. the initial scan of
    // a watch resumed at startup) were dropped, so backfill from the backend's
    // backlog. Wait for the listener registrations above to complete first, so
    // every event is seen either live or in the snapshot; on conflicts the
    // live entry wins.
    Promise.all([unlistenFileChange, unlistenUploadStatus])
      .catch(() => undefined) // backfill even if listener setup failed
      .then(() => {
        invoke<FileChangeEvent[]>("get_file_change_backlog")
          .then((backlog) => {
            if (backlog.length === 0) return;
            setFileChanges((prev) => {
              const seen = new Set(prev.map((change) => change.path));
              const merged = [
                ...prev,
                ...backlog.filter((change) => !seen.has(change.path)),
              ];
              return merged.slice(0, 500);
            });
          })
          .catch((err) =>
            console.error("Failed to load file change backlog:", err)
          );
        invoke<FileUploadStatus[]>("get_upload_status_backlog")
          .then((backlog) => {
            if (backlog.length === 0) return;
            setUploadStatuses((prev) => {
              const next = new Map<string, FileUploadStatus["status"]>();
              for (const status of backlog) {
                next.set(status.relative_path, status.status);
              }
              for (const [path, status] of prev) next.set(path, status);
              while (next.size > 1000) {
                const firstKey = next.keys().next().value;
                if (firstKey === undefined) break;
                next.delete(firstKey);
              }
              return next;
            });
          })
          .catch((err) =>
            console.error("Failed to load upload status backlog:", err)
          );
      });

    return () => {
      unlistenFileChange.then((fn) => fn());
      unlistenHeartbeat.then((fn) => fn());
      unlistenUploadStatus.then((fn) => fn());
      unlistenWatchResumed.then((fn) => fn());
      unlistenWatchResumeFailed.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    // Load recent directories on mount
    loadRecentDirs();
  }, []);

  useEffect(() => {
    // Handle scroll to show/hide scroll-to-top button
    const handleScroll = () => {
      // Show button if user has scrolled down more than 200px
      setShowScrollToTop(window.scrollY > 200);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  async function loadRecentDirs() {
    try {
      const recent = await getRecentDirs();
      setRecentDirs(recent);
    } catch (err) {
      console.error("Failed to load recent directories:", err);
    }
  }

  async function selectFolder() {
    try {
      const folderPath = await open({
        directory: true,
        multiple: false,
      });

      if (folderPath) {
        await selectAndWatchFolder(folderPath as string);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function selectAndWatchFolder(folderPath: string) {
    try {
      // Stop watching previous folder if any
      if (selectedFolder) {
        await stopWatching();
      }

      setSelectedFolder(folderPath);
      setFileChanges([]); // Clear previous changes

      // Add to recent directories
      await pushRecent(folderPath);
      await loadRecentDirs(); // Refresh the recent dirs list

      // Automatically start watching the new folder
      try {
        await invoke("start_watching", { folderPath });
      } catch (err) {
        console.error("Failed to start watching:", err);
      }
    } catch (err) {
      console.error("Failed to select folder:", err);
    }
  }

  async function selectRecentFolder(folderPath: string) {
    await selectAndWatchFolder(folderPath);
  }

  async function stopWatching() {
    try {
      await invoke("stop_watching");
      setSelectedFolder("");
      setFileChanges([]);
    } catch (err) {
      console.error("Failed to stop watching:", err);
    }
  }

  function getRelativePath(absolutePath: string): string {
    return getRelativePathFromFolder(absolutePath, selectedFolder);
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const getUploadStatus = useCallback(
    (filePath: string): FileUploadStatus["status"] | undefined => {
      const relativePath = getRelativePath(filePath);
      return uploadStatuses.get(relativePath);
    },
    [uploadStatuses, selectedFolder]
  );

  // Filter file changes based on search query
  const filteredFileChanges = useMemo(() => {
    if (!searchQuery.trim()) return fileChanges;
    const query = searchQuery.toLowerCase();
    return fileChanges.filter((change) => {
      const relativePath = getRelativePath(change.path);
      return relativePath.toLowerCase().includes(query);
    });
  }, [fileChanges, searchQuery, selectedFolder]);

  return (
    <main className="container mx-auto p-6 max-w-4xl">
      <div className="space-y-8 mt-6 max-w-lg mx-auto">
        {/* Folder Selection */}
        {!selectedFolder ? (
          <Button onClick={selectFolder} size="lg" className="w-full rounded-full">
            Select Folder to Sync
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button onClick={selectFolder} size="lg" className="flex-1 rounded-full">
              Change Folder
            </Button>
            <Button onClick={stopWatching} variant="destructive" size="lg" className="flex-1 rounded-full">
              Stop
            </Button>
          </div>
        )}

        {/* Recent Directories */}
        {recentDirs.length > 0 && !selectedFolder && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">
              Recent folders
            </p>
            <div className="flex flex-col gap-2 items-start w-full">
              {recentDirs.map((dir, index) => {
                const { name, parent } = splitDirPath(dir);
                return (
                  <button
                    key={`${dir}-${index}`}
                    onClick={() => selectRecentFolder(dir)}
                    className="text-xs text-muted-foreground hover:underline text-left py-0.5"
                    title={dir}
                  >
                    {parent}/{name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selectedFolder && (
          <div className="space-y-3">
            <div className="">
              <p className="text-xs text-muted-foreground mb-1">
                Currently watching
              </p>

              <span
                className="text-sm break-all cursor-copy inline"
                onClick={() => {
                  navigator.clipboard.writeText(selectedFolder);
                  toast.success("Copied to clipboard");
                }}
                title="Click to copy path"
              >
                {selectedFolder}
              </span>
            </div>
          </div>
        )}

        {/* File Changes */}
        {selectedFolder && (
          <>
            <div
              ref={logsRef}
              className="sticky top-0 m-0 space-y-3 my-2 py-2 z-40"
            >
              <div className="relative rounded-full bg-background">
                <div className="flex flex-col border dark:border-none rounded-full px-4 py-3 shadow-sm dark:bg-input/30">
                  <div className="flex items-center gap-1">

                    <Search className="text-muted-foreground h-4 w-4 flex-shrink-0 ml-1" />
                    <Input
                      placeholder="Search logs..."
                      autoFocus
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full border-none shadow-none leading-snug focus-visible:ring-0 !bg-transparent h-auto py-0"
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-1 mb-8">
              {filteredFileChanges.length === 0 ? (
                <p className="text-muted-foreground text-center text-sm py-4">
                  {fileChanges.length === 0
                    ? "No files found"
                    : "No files match your search"}
                </p>
              ) : (
                filteredFileChanges.map((change) => (
                  <FileChangeRow
                    key={change.path}
                    change={change}
                    status={getUploadStatus(change.path)}
                    selectedFolder={selectedFolder}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* VS Code Style Status Ribbon */}
      <div className="fixed bottom-0 left-0 right-0 bg-background border-t text-xs px-4 flex items-center justify-between z-50">
        <div className="flex items-center space-x-4">
          <Tooltip>
            <TooltipTrigger>
              <div className="flex items-center space-x-2">
                <div
                  className={`w-2 h-2 rounded-full ${heartbeatStatus?.status?.status === "online"
                      ? "bg-success"
                      : "bg-destructive"
                    }`}
                ></div>
                <span>
                  {heartbeatStatus?.status?.status === "online"
                    ? "Connected"
                    : "Disconnected"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent collisionPadding={8}>
              {heartbeatStatus?.status?.status === "online" ? (
                <>
                  <span>Online since</span>{" "}
                  {new Date(heartbeatStatus?.status?.first_seen).toLocaleString(
                    undefined,
                    { dateStyle: "short", timeStyle: "short" }
                  )}
                </>
              ) : heartbeatStatus?.status?.last_seen ? (
                <>
                  <span>Offline since</span>{" "}
                  {new Date(heartbeatStatus?.status?.last_seen).toLocaleString(
                    undefined,
                    { dateStyle: "short", timeStyle: "short" }
                  )}
                </>
              ) : (
                <>
                  <span>Offline</span>
                </>
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center space-x-4">
          <Tooltip>
            <TooltipTrigger>
              <span className="flex items-center gap-2">
                {(() => {
                  const pending = (progress?.total_queued ?? 0) + (progress?.in_flight ?? 0);
                  if (pending > 0) {
                    return <><Loader2 className="h-3 w-3 animate-spin" /><span>Syncing <span className="font-mono tabular-nums">{pending}</span> file{pending === 1 ? "" : "s"}</span></>;
                  }
                  return <><CloudCheck className="h-3 w-3" /><span>Up to date</span></>;
                })()}
              </span>
            </TooltipTrigger>
            <TooltipContent collisionPadding={8}>
              <div className="flex flex-col">
                <span>
                  {appVersion ? `Labric Sync v${appVersion.version}` : "Labric Sync"}
                </span>
                {appVersion?.updatedAt && (
                  <span>
                    Updated{" "}
                    {new Date(appVersion.updatedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
          <SessionContextSheet>
            {sessionActive ? (
              <button className="flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-accent-foreground/10 text-accent-foreground text-xs">
                <UserIcon className="w-3 h-3" />
                <span>Session active</span>
                {sessionTimeRemaining != null && (
                  <span className="font-mono tabular-nums text-[0.9em]">
                    {(() => {
                      const h = Math.floor(sessionTimeRemaining / 3600000);
                      const m = Math.floor((sessionTimeRemaining % 3600000) / 60000);
                      return h > 0 ? `${h}h ${m}m` : `${m}m`;
                    })()}
                  </span>
                )}
              </button>
            ) : (
              <button className="hover:bg-muted p-1 rounded">
                <UserIcon className="w-3 h-3" />
              </button>
            )}
          </SessionContextSheet>
          <UploadSettingsSheet>
            <button className="hover:bg-muted p-1 rounded">
              <Settings2Icon className="w-3 h-3" />
            </button>
          </UploadSettingsSheet>
        </div>
      </div>

      {/* Scroll to Top FAB */}
      {showScrollToTop && (
        <Button
          onClick={scrollToTop}
          variant="outline"
          className="fixed bottom-8 right-6 rounded-full z-40"
          size="icon"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      )}
    </main>
  );
}
