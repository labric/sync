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

// After the server rejected this device's token, the next pairing keeps the
// watched folder and upload queue only if it is to the same organization, so
// one organization's files never upload into another.
export const keepsWatchedFolder = (
  rejectedOrgId: string | null,
  newOrgId: string | undefined,
): boolean => rejectedOrgId != null && rejectedOrgId === newOrgId;
