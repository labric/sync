export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type UpdateState =
  | { status: 'none' }
  | { status: 'downloading' | 'ready' | 'postponed' | 'installing' | 'failed'; version: string };

export type UpdateEvent =
  | { type: 'found' | 'downloaded' | 'downloadFailed'; version: string }
  | { type: 'checkFailed' | 'postponed' | 'installStarted' | 'installFailed' };

export const initialUpdateState: UpdateState = { status: 'none' };

// Returns the same object when an event changes nothing, so callers can tell
// whether a found update needs downloading.
export function updateReducer(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case 'found':
      // Only one update is held at a time; a newer one is found again after the relaunch.
      return state.status === 'none' ? { status: 'downloading', version: event.version } : state;
    case 'downloaded':
      return state.status === 'downloading' && state.version === event.version
        ? { status: 'ready', version: event.version }
        : state;
    case 'downloadFailed':
      return state.status === 'downloading' && state.version === event.version ? initialUpdateState : state;
    case 'checkFailed':
      return state;
    case 'postponed':
      return state.status === 'ready' ? { status: 'postponed', version: state.version } : state;
    case 'installStarted':
      return state.status === 'ready' || state.status === 'postponed' || state.status === 'failed'
        ? { status: 'installing', version: state.version }
        : state;
    case 'installFailed':
      return state.status === 'installing' ? { status: 'failed', version: state.version } : state;
  }
}

// What the app info button shows; undefined while there is nothing to install.
export function pendingUpdate(state: UpdateState) {
  if (state.status === 'none' || state.status === 'downloading') return undefined;
  return { version: state.version, postponed: state.status === 'postponed', installing: state.status === 'installing' };
}
