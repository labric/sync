// When the running version first started on this machine. The updater relaunches
// the app right after installing, so for an update this is when it was installed.
export interface InstallRecord {
  version: string;
  since: string; // ISO timestamp
  previous: string | null;
  freshInstall: boolean;
}

// firstRun: no record exists and the app has no saved settings yet.
export function nextInstallRecord(
  stored: InstallRecord | null,
  version: string,
  now: string,
  firstRun: boolean
): InstallRecord {
  if (stored?.version === version) return stored;
  return {
    version,
    since: now,
    previous: stored?.version ?? null,
    freshInstall: !stored && firstRun,
  };
}

export function describeInstall(record: InstallRecord, formatDate: (iso: string) => string): string {
  const when = formatDate(record.since);
  if (record.freshInstall) return `Installed ${when}`;
  return record.previous ? `Updated ${when} from ${record.previous}` : `Updated ${when}`;
}
