import { CircleArrowDown, Loader2 } from "lucide-react";
import { installUpdate, useUpdateState } from "@/hooks/useAppUpdater";
import { cn } from "@/lib/utils";

const labels = {
  ready: "Restart to update",
  postponed: "Update available",
  installing: "Updating…",
  failed: "Retry update",
};

export function UpdateButton() {
  const update = useUpdateState();
  if (update.status === "none" || update.status === "downloading") return null;

  const installing = update.status === "installing";
  return (
    <button
      onClick={installUpdate}
      disabled={installing}
      title={`Install v${update.version} and restart`}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-xs",
        update.status === "postponed"
          ? "text-muted-foreground hover:bg-muted"
          : "bg-accent-foreground/10 text-accent-foreground"
      )}
    >
      {installing ? <Loader2 className="w-3 h-3 animate-spin" /> : <CircleArrowDown className="w-3 h-3" />}
      <span>{labels[update.status]}</span>
    </button>
  );
}
