import { useRef, useState } from "react";
import { CircleArrowDown, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInstallRecord } from "@/hooks/useInstallRecord";
import { describeInstall } from "@/lib/install-record";
import { cn } from "@/lib/utils";

export interface PendingUpdate {
  version: string;
  onInstall: () => void;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// Long enough to move the pointer across the gap between the trigger and the panel.
const CLOSE_DELAY_MS = 200;

export function InstallDetails() {
  const record = useInstallRecord();
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-medium">Labric Sync{record && ` ${record.version}`}</p>
      {record && <p className="text-xs text-muted-foreground">{describeInstall(record, formatDate)}</p>}
    </div>
  );
}

interface Props {
  align?: "center" | "end";
  className?: string;
  // While an update is waiting, the icon becomes a labelled pill and the panel offers the restart.
  update?: PendingUpdate;
}

// Hovering or focusing the icon opens a panel with the version details. The panel stays in
// the DOM right after the trigger so Tab moves from the trigger into it.
export function AppInfoButton({ align = "center", className, update }: Props) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const openOnClick = (e: React.MouseEvent) => {
    e.preventDefault(); // open, never toggle closed a panel the hover just opened
    show();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span
        className="inline-flex"
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && hide()}
      >
        <PopoverTrigger asChild onClick={openOnClick}>
          {update ? (
            <button className="flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-xs bg-accent-foreground/10 text-accent-foreground cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <CircleArrowDown className="size-3" />
              <span>Update ready</span>
            </button>
          ) : (
            <Button variant="ghost" size="icon-xs" className={cn("cursor-pointer", className)} aria-label="About Labric Sync">
              <Info />
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent
          portal={false}
          side="top"
          align={align}
          className="space-y-3"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <InstallDetails />
          {update && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs">Version {update.version} is ready to install.</p>
              <Button size="xs" className="w-full rounded-full cursor-pointer" onClick={update.onInstall}>
                <CircleArrowDown />
                Restart to update
              </Button>
            </div>
          )}
        </PopoverContent>
      </span>
    </Popover>
  );
}
