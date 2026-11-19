import { useEffect, useSyncExternalStore } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import {
  type UpdateEvent,
  type UpdateState,
  UPDATE_CHECK_INTERVAL_MS,
  initialUpdateState,
  pendingUpdate,
  updateReducer,
} from '@/lib/update-state';
import type { PendingUpdate } from '@/components/app-info-button';

const TOAST_ID = 'update-notification';
// A hung download would otherwise block every later check until the app restarts.
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

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
    await update.download(undefined, { timeout: DOWNLOAD_TIMEOUT_MS });
  } catch (error) {
    console.error('Failed to download update:', error);
    dispatch({ type: 'downloadFailed', version: update.version });
    await update.close();
    return;
  }
  await downloadedUpdate?.close();
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

async function installUpdate() {
  const update = downloadedUpdate;
  if (!update) return;
  const before = state;
  dispatch({ type: 'installStarted' });
  if (state === before) return;
  toast.dismiss(TOAST_ID);
  try {
    await update.install();
  } catch (error) {
    console.error('Failed to install update:', error);
    dispatch({ type: 'installFailed' });
    toast.error('Failed to install update', { description: 'Try again from "Update ready".' });
    return;
  }
  try {
    await relaunch();
  } catch (error) {
    console.error('Failed to relaunch after installing the update:', error);
    toast.error('Update installed', { description: 'Quit and reopen Labric Sync to finish.' });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingUpdate(): PendingUpdate | undefined {
  const update = pendingUpdate(useSyncExternalStore(subscribe, () => state));
  return update && { ...update, onInstall: installUpdate };
}

// Mounted once at the root, so updates are checked on every screen, signed in or not.
export function useAppUpdater() {
  useEffect(() => {
    checkForUpdate();
    const interval = setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
}
