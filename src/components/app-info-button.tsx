import { useRef, useState } from "react";
import { CircleArrowDown, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInstallRecord } from "@/hooks/useInstallRecord";
import { describeInstall } from "@/lib/install-record";

export interface PendingUpdate {
  version: string;
  installing?: boolean;
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
  iconClassName?: string; // sizes the bare icon; the update pill keeps its own size
  // While an update is waiting, the icon becomes a labelled pill and the panel offers the restart.
  update?: PendingUpdate;
}

// The panel is open while the pointer is over the icon or panel, or keyboard focus is in
// them. It stays in the DOM right after the trigger so Tab moves from the trigger into it.
export function AppInfoButton({ align = "center", iconClassName, update }: Props) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const hovered = useRef(false);
  const focused = useRef(false);

  const sync = () => {
    window.clearTimeout(closeTimer.current);
    if (hovered.current || focused.current) setOpen(true);
    else closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const openOnClick = (e: React.MouseEvent) => {
    e.preventDefault(); // open, never toggle closed a panel the hover just opened
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span
        className="inline-flex"
        onPointerEnter={() => {
          hovered.current = true;
          sync();
        }}
        onPointerLeave={() => {
          hovered.current = false;
          sync();
        }}
        onFocus={(e) => {
          // Only keyboard focus: webviews re-focus a clicked icon when the window is reactivated.
          if (!e.target.matches(":focus-visible")) return;
          focused.current = true;
          sync();
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget)) return;
          focused.current = false;
          sync();
        }}
      >
        <PopoverTrigger asChild onClick={openOnClick}>
          {update ? (
            <button className="flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-xs bg-accent-foreground/10 text-accent-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <CircleArrowDown className="size-3" />
              <span>Update ready</span>
            </button>
          ) : (
            <Button variant="ghost" size="icon-xs" className={iconClassName} aria-label="About Labric Sync">
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
          onFocusOutside={(e) => e.preventDefault()}
        >
          <InstallDetails />
          {update && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs">Version {update.version} is ready to install.</p>
              <Button size="xs" className="w-full rounded-full cursor-pointer" onClick={update.onInstall} aria-disabled={update.installing}>
                {update.installing ? <Loader2 className="animate-spin" /> : <CircleArrowDown />}
                {update.installing ? "Updating…" : "Restart to update"}
              </Button>
            </div>
          )}
        </PopoverContent>
      </span>
    </Popover>
  );
}
