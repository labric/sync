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
