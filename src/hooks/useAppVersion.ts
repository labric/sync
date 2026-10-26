import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { recordInstalledVersion } from '@/lib/store';

interface AppVersion {
  version: string;
  // ISO timestamp of when this version first ran, or null if it couldn't be stored
  updatedAt: string | null;
}

// Neither value changes while the app is running, so fetch them once and
// share the result with every caller.
let cachedVersion: AppVersion | null = null;
const versionPromise = getVersion()
  .then(async (version) => {
    let updatedAt: string | null = null;
    try {
      updatedAt = await recordInstalledVersion(version);
    } catch (error) {
      console.error('Failed to record app update time:', error);
    }
    cachedVersion = { version, updatedAt };
    return cachedVersion;
  })
  .catch((error) => {
    console.error('Failed to read app version:', error);
    return null;
  });

export function useAppVersion() {
  const [version, setVersion] = useState<AppVersion | null>(cachedVersion);

  useEffect(() => {
    if (cachedVersion) return;
    let cancelled = false;
    versionPromise.then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
