export const RECOVERY_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export interface RecoveryMessageInput {
  challengeId: string;
  player: string;
  paymentHash: string;
  chainId: number;
  contractAddress: string;
  /** Milliseconds since Unix epoch. */
  issuedAt: number;
}

/** EIP-191 personal-sign message shared by the wallet and recovery verifier. */
export function getRecoveryMessage(input: RecoveryMessageInput): string {
  return [
    'Monad Rug Arena: recover my paid challenge',
    `Challenge: ${input.challengeId.toLowerCase()}`,
    `Player: ${input.player.toLowerCase()}`,
    `Payment: ${input.paymentHash.toLowerCase()}`,
    `Chain ID: ${input.chainId}`,
    `Contract: ${input.contractAddress.toLowerCase()}`,
    `Issued at (milliseconds): ${input.issuedAt}`,
    'This signature restores access to an existing paid challenge. It does not authorize a payment.',
  ].join('\n');
}

export type SessionRecoveryRequest =
  | { checkpoint: string; paymentHash?: string }
  | { challengeId: string; player: string; paymentHash: string; issuedAt: number; signature: string };
