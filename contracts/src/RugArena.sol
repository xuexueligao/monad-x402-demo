// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Players prepay a challenge. A signed server verdict settles it and pays the payer.
contract RugArena is EIP712, ReentrancyGuard {
    struct ChallengeResult {
        bytes32 challengeId;
        address player;
        uint256 roundId;
        bool success;
        uint256 score;
        uint256 deadline;
        bytes32 transcriptHash;
    }

    struct GameRound {
        uint256 id;
        uint256 prizePool;
        uint256 challengeFee;
        uint256 endsAt;
        bool active;
        address winner;
        uint256 reward;
        bool rewardClaimed;
    }

    struct PlayerStats {
        uint256 attempts;
        uint256 successes;
        uint256 score;
        uint256 wins;
    }

    struct ChallengeRecord {
        address player;
        uint256 roundId;
        bool success;
        uint256 score;
        uint256 fee;
        uint256 reward;
        bytes32 transcriptHash;
        uint256 settledAt;
        bool settled;
        uint256 enteredAt;
        uint256 expiresAt;
    }

    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "ChallengeResult(bytes32 challengeId,address player,uint256 roundId,bool success,uint256 score,uint256 deadline,bytes32 transcriptHash)"
    );
    uint256 public constant SUCCESS_SCORE = 100;
    uint256 public constant FAILURE_SCORE = 10;

    address public immutable resultSigner;
    uint256 public immutable challengeFee;
    uint256 public immutable poolShareBps;
    uint256 public immutable rewardBps;
    uint256 public immutable roundDuration;
    uint256 public immutable challengeDuration;
    uint256 public currentRoundId;
    uint256 public prizePool;
    uint256 public totalChallenges;

    mapping(uint256 => GameRound) private _rounds;
    mapping(address => PlayerStats) private _players;
    mapping(bytes32 => ChallengeRecord) private _challenges;
    address[] private _playerAddresses;

    event ChallengeEntered(bytes32 indexed challengeId, address indexed player, uint256 indexed roundId, uint256 fee, uint256 expiresAt);
    event ChallengeSettled(bytes32 indexed challengeId, address indexed player, uint256 indexed roundId, bool success, uint256 score, uint256 fee, uint256 reward);
    event PrizePoolUpdated(uint256 indexed roundId, uint256 prizePool);
    event WinnerDeclared(uint256 indexed roundId, address indexed player, bytes32 challengeId, uint256 reward);
    event RewardPaid(uint256 indexed roundId, address indexed player, bytes32 indexed challengeId, uint256 amount);
    event GameRoundStarted(uint256 indexed roundId, uint256 endsAt, uint256 prizePool);

    error InvalidConfiguration();
    error InvalidChallenge();
    error WrongPlayer();
    error WrongRound();
    error RoundClosed();
    error RoundStillActive();
    error ChallengeAlreadySettled();
    error ChallengeAlreadyEntered();
    error ChallengeNotEntered();
    error ResultExpired();
    error InvalidSignature();
    error IncorrectFee();
    error InvalidScore();
    error InsufficientAvailableBalance();
    error NativeTransferFailed();

    constructor(address resultSigner_, uint256 challengeFee_, uint256 poolShareBps_, uint256 rewardBps_, uint256 roundDuration_, uint256 challengeDuration_)
        payable EIP712("Monad Rug Arena", "1")
    {
        if (resultSigner_ == address(0) || challengeFee_ == 0 || poolShareBps_ > 10_000 || rewardBps_ == 0 || rewardBps_ > 10_000 || roundDuration_ == 0 || challengeDuration_ == 0) {
            revert InvalidConfiguration();
        }
        resultSigner = resultSigner_;
        challengeFee = challengeFee_;
        poolShareBps = poolShareBps_;
        rewardBps = rewardBps_;
        roundDuration = roundDuration_;
        challengeDuration = challengeDuration_;
        prizePool = msg.value;
        _startRound();
    }

    /// @notice Donations are testnet MON and are added to the actual shared prize pool.
    receive() external payable {
        prizePool += msg.value;
        _rounds[currentRoundId].prizePool = prizePool;
        emit PrizePoolUpdated(currentRoundId, prizePool);
    }

    /// @notice Anyone can start the next admission epoch once this public round expires.
    function startGameRound() external {
        GameRound storage previous = _rounds[currentRoundId];
        if (previous.active && block.timestamp < previous.endsAt) revert RoundStillActive();
        previous.active = false;
        _startRound();
    }

    /// @notice Payment opens one three-message session; its fee is never charged again.
    function enterChallenge(bytes32 challengeId, uint256 roundId) external payable {
        if (challengeId == bytes32(0)) revert InvalidChallenge();
        if (_challenges[challengeId].player != address(0)) revert ChallengeAlreadyEntered();
        if (roundId != currentRoundId) revert WrongRound();
        GameRound storage round = _rounds[roundId];
        if (!round.active || block.timestamp >= round.endsAt) revert RoundClosed();
        if (msg.value != challengeFee) revert IncorrectFee();

        ChallengeRecord storage challenge = _challenges[challengeId];
        challenge.player = msg.sender;
        challenge.roundId = roundId;
        challenge.fee = msg.value;
        challenge.enteredAt = block.timestamp;
        challenge.expiresAt = block.timestamp + challengeDuration;

        PlayerStats storage stats = _players[msg.sender];
        if (stats.attempts == 0) _playerAddresses.push(msg.sender);
        stats.attempts += 1;
        totalChallenges += 1;
        prizePool += msg.value * poolShareBps / 10_000;
        round.prizePool = prizePool;
        emit ChallengeEntered(challengeId, msg.sender, roundId, msg.value, challenge.expiresAt);
        emit PrizePoolUpdated(roundId, prizePool);
    }

    /// @notice The backend pays the gas. Only the prepaid player can receive a reward.
    /// @dev A paid session remains settleable after the public admission round changes.
    function settleChallenge(ChallengeResult calldata result, bytes calldata signature) external nonReentrant {
        if (result.challengeId == bytes32(0) || result.transcriptHash == bytes32(0)) revert InvalidChallenge();
        ChallengeRecord storage challenge = _challenges[result.challengeId];
        if (challenge.player == address(0)) revert ChallengeNotEntered();
        if (challenge.settled) revert ChallengeAlreadySettled();
        if (result.player != challenge.player) revert WrongPlayer();
        if (result.roundId != challenge.roundId) revert WrongRound();
        GameRound storage round = _rounds[challenge.roundId];
        if (block.timestamp > result.deadline) revert ResultExpired();
        if (result.score != (result.success ? SUCCESS_SCORE : FAILURE_SCORE)) revert InvalidScore();
        (address recovered, ECDSA.RecoverError recoveryError,) = ECDSA.tryRecover(hashResult(result), signature);
        if (recoveryError != ECDSA.RecoverError.NoError || recovered != resultSigner) revert InvalidSignature();

        PlayerStats storage stats = _players[challenge.player];
        stats.score += result.score;

        uint256 reward;
        if (result.success) {
            stats.successes += 1;
            stats.wins += 1;
            round.winner = challenge.player;
            reward = prizePool * rewardBps / 10_000;
            if (reward > address(this).balance) revert InsufficientAvailableBalance();
            prizePool -= reward;
            round.reward = reward;
            round.rewardClaimed = true;
        }
        round.prizePool = prizePool;
        _rounds[currentRoundId].prizePool = prizePool;
        challenge.success = result.success;
        challenge.score = result.score;
        challenge.reward = reward;
        challenge.transcriptHash = result.transcriptHash;
        challenge.settledAt = block.timestamp;
        challenge.settled = true;
        if (result.success) {
            (bool sent,) = payable(challenge.player).call{value: reward}("");
            if (!sent) revert NativeTransferFailed();
            emit RewardPaid(result.roundId, challenge.player, result.challengeId, reward);
            emit WinnerDeclared(result.roundId, challenge.player, result.challengeId, reward);
        }
        emit ChallengeSettled(result.challengeId, challenge.player, result.roundId, result.success, result.score, challenge.fee, reward);
        emit PrizePoolUpdated(currentRoundId, prizePool);
    }

    function getCurrentRound() external view returns (GameRound memory round) {
        round = _rounds[currentRoundId];
        round.prizePool = prizePool;
        round.active = round.active && block.timestamp < round.endsAt;
    }

    function getRound(uint256 roundId) external view returns (GameRound memory round) {
        round = _rounds[roundId];
        round.active = round.active && block.timestamp < round.endsAt;
    }

    function getPlayerStats(address player) external view returns (PlayerStats memory) { return _players[player]; }
    function getChallenge(bytes32 challengeId) external view returns (ChallengeRecord memory) { return _challenges[challengeId]; }
    function getPlayers() external view returns (address[] memory) { return _playerAddresses; }

    function hashResult(ChallengeResult calldata result) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            RESULT_TYPEHASH, result.challengeId, result.player, result.roundId, result.success,
            result.score, result.deadline, result.transcriptHash
        )));
    }

    function _startRound() private {
        uint256 id = ++currentRoundId;
        uint256 endsAt = block.timestamp + roundDuration;
        _rounds[id] = GameRound(id, prizePool, challengeFee, endsAt, true, address(0), 0, false);
        emit GameRoundStarted(id, endsAt, prizePool);
    }
}
