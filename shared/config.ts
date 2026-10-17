import network from './network.json';

export const TESTNET = network;
export const GAME_RULES = {
  maxMessages: 3,
  challengeDurationSeconds: 180,
  signatureDurationSeconds: 300,
  challengeFeeMon: '10',
  poolShareBps: 8000,
  rewardBps: 5000,
  roundDurationSeconds: 7200,
  successScore: 100,
  failureScore: 10,
  winPhrase: '金库开门，金币归你',
} as const;

export const RESULT_TYPES = {
  ChallengeResult: [
    { name: 'challengeId', type: 'bytes32' },
    { name: 'player', type: 'address' },
    { name: 'roundId', type: 'uint256' },
    { name: 'success', type: 'bool' },
    { name: 'score', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'transcriptHash', type: 'bytes32' },
  ],
} as const;

export const RESULT_DOMAIN = { name: 'Monad Rug Arena', version: '1' } as const;
