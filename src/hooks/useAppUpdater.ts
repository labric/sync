import { useEffect, useSyncExternalStore } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import {
  type UpdateEvent,
  type UpdateState,
  UPDATE_CHECK_INTERVAL_MS,
  initialUpdateState,
  updateReducer,
} from '@/lib/update-state';

const TOAST_ID = 'update-notification';

let state: UpdateState = initialUpdateState;
let downloadedUpdate: Update | null = null;
const listeners = new Set<() => void>();

function dispatch(event: UpdateEvent) {
  const next = updateReducer(state, event);
  if (next !== state) {
    state = next;
    listeners.forEach((listener) => listener());
  }
}

async function checkForUpdate() {
  let update: Update | null;
  try {
    update = await check();
  } catch (error) {
    console.error('Failed to check for updates:', error);
    dispatch({ type: 'checkFailed' });
    return;
  }
  if (!update) return;

  const before = state;
  dispatch({ type: 'found', version: update.version });
  if (state === before) {
    await update.close();
    return;
  }

  try {
    await update.download();
  } catch (error) {
    console.error('Failed to download update:', error);
    dispatch({ type: 'downloadFailed', version: update.version });
    await update.close();
    return;
  }
  downloadedUpdate = update;
  dispatch({ type: 'downloaded', version: update.version });

  const postpone = () => dispatch({ type: 'postponed' });
  toast(`New Update v${update.version}`, {
    id: TOAST_ID,
    description: 'Restart to install the update',
    action: { label: 'Restart', onClick: installUpdate },
    cancel: { label: 'Later', onClick: postpone },
    onDismiss: postpone,
    duration: Infinity,
  });
}

export async function installUpdate() {
  const before = state;
  dispatch({ type: 'installStarted' });
  if (state === before || !downloadedUpdate) return;
  toast.dismiss(TOAST_ID);
  try {
    await downloadedUpdate.install();
    await relaunch();
  } catch (error) {
    console.error('Failed to install update:', error);
    dispatch({ type: 'installFailed' });
    toast.error('Failed to install update', { description: 'Try again from the update button.' });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateState() {
  return useSyncExternalStore(subscribe, () => state);
}

// Mounted once at the root, so updates are checked on every screen, signed in or not.
export function useAppUpdater() {
  useEffect(() => {
    checkForUpdate();
    const interval = setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
}
