import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { recordInstall } from "@/lib/store";
import type { InstallRecord } from "@/lib/install-record";

// The record cannot change while the app runs, so it is read once and shared;
// a failed read is not kept, so the next mount tries again.
let recordPromise: Promise<InstallRecord | null> | null = null;

function loadInstallRecord() {
  recordPromise ??= getVersion()
    .then(recordInstall)
    .catch((error) => {
      console.error("Failed to read the installed version:", error);
      recordPromise = null;
      return null;
    });
  return recordPromise;
}

export function useInstallRecord() {
  const [record, setRecord] = useState<InstallRecord | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadInstallRecord().then((r) => !cancelled && setRecord(r));
    return () => {
      cancelled = true;
    };
  }, []);
  return record;
}
