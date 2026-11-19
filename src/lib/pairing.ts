export interface PairCodeResponse {
  success: boolean;
  otp_code?: string;
  pairing_secret?: string;
}

export interface PollPairingBody {
  device_fingerprint: string;
  pairing_secret?: string;
}

// Servers that predate pairing secrets return none and accept a poll without one.
export const pollPairingBody = (
  deviceFingerprint: string,
  pairingSecret: string | null,
): PollPairingBody =>
  pairingSecret
    ? { device_fingerprint: deviceFingerprint, pairing_secret: pairingSecret }
    : { device_fingerprint: deviceFingerprint };

// The organization of the token the device last had, kept after a sign-out or
// a rejection until the device is paired again.
export interface PreviousPairing {
  org_id: string | null;
}

// Whether a new pairing goes to a different organization than the device's
// last token, so the old folder, queue and session user must not carry over.
export const pairsElsewhere = (
  orgId: string | undefined,
  rejected: PreviousPairing | null,
  signedOut: PreviousPairing | null,
): boolean => {
  const previous = rejected ?? signedOut;
  return previous !== null && previous.org_id !== orgId;
};
