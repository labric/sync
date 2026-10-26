import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

// The version never changes while the app is running, so fetch it once and
// share the result with every caller.
let cachedVersion: string | null = null;
const versionPromise = getVersion()
  .then((version) => {
    cachedVersion = version;
    return version;
  })
  .catch((error) => {
    console.error('Failed to read app version:', error);
    return null;
  });

export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(cachedVersion);

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
