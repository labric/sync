import { CircleArrowDown, Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInstallRecord } from "@/hooks/useInstallRecord";
import { describeInstall } from "@/lib/install-record";

export interface PendingUpdate {
  version: string;
  // After "Later" on the update toast the pill stays, but muted.
  postponed?: boolean;
  installing?: boolean;
  onInstall: () => void;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

interface Props {
  align?: "center" | "end";
  className?: string;
  // While an update is waiting, the icon becomes a labelled pill and the panel offers the restart.
  update?: PendingUpdate;
}

export function AppInfoButton({ align = "center", className, update }: Props) {
  const record = useInstallRecord();

  return (
    <Popover>
      <PopoverTrigger asChild>
        {update ? (
          <button
            className={cn(
              "flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-xs",
              update.postponed ? "text-muted-foreground hover:bg-muted" : "bg-accent-foreground/10 text-accent-foreground"
            )}
          >
            <CircleArrowDown className="size-3" />
            <span>Update ready</span>
          </button>
        ) : (
          <Button variant="ghost" size="icon-xs" className={className} aria-label="About Labric Sync">
            <Info />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align={align} className="space-y-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Labric Sync {record?.version}</p>
          {record && <p className="text-xs text-muted-foreground">{describeInstall(record, formatDate)}</p>}
        </div>
        {update && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs">Version {update.version} is ready to install.</p>
            <Button size="xs" className="w-full rounded-full" onClick={update.onInstall} disabled={update.installing}>
              {update.installing ? <Loader2 className="animate-spin" /> : <CircleArrowDown />}
              {update.installing ? "Updating…" : "Restart to update"}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
