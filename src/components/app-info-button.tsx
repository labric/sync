import { useRef, useState } from "react";
import { CircleArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInstallRecord } from "@/hooks/useInstallRecord";
import { describeInstall } from "@/lib/install-record";

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
  update?: PendingUpdate;
}

// Shown only while an update is waiting. Hovering or focusing it opens a panel with the
// version details and the restart; the panel stays in the DOM right after the trigger so
// Tab moves from the trigger to the restart button.
export function AppInfoButton({ align = "center", update }: Props) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  if (!update) return null;

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
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
        <PopoverTrigger asChild>
          <button
            onClick={(e) => {
              e.preventDefault(); // open, never toggle closed a panel the hover just opened
              show();
            }}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-xs bg-accent-foreground/10 text-accent-foreground cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <CircleArrowDown className="size-3" />
            <span>Update ready</span>
          </button>
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
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs">Version {update.version} is ready to install.</p>
            <Button size="xs" className="w-full rounded-full cursor-pointer" onClick={update.onInstall}>
              <CircleArrowDown />
              Restart to update
            </Button>
          </div>
        </PopoverContent>
      </span>
    </Popover>
  );
}
