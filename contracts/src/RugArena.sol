// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Multiplayer testnet game. The server judges dialogue; players pay and settle on chain.
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
    uint256 public currentRoundId;
    uint256 public prizePool;
    uint256 public reservedRewards;
    uint256 public totalChallenges;

    mapping(uint256 => GameRound) private _rounds;
    mapping(address => PlayerStats) private _players;
    mapping(bytes32 => ChallengeRecord) private _challenges;
    address[] private _playerAddresses;

    event ChallengeSettled(bytes32 indexed challengeId, address indexed player, uint256 indexed roundId, bool success, uint256 score, uint256 fee, uint256 reward);
    event PrizePoolUpdated(uint256 indexed roundId, uint256 prizePool);
    event WinnerDeclared(uint256 indexed roundId, address indexed player, bytes32 challengeId, uint256 reward);
    event RewardClaimed(uint256 indexed roundId, address indexed player, uint256 amount);
    event GameRoundStarted(uint256 indexed roundId, uint256 endsAt, uint256 prizePool);

    error InvalidConfiguration();
    error InvalidChallenge();
    error WrongPlayer();
    error WrongRound();
    error RoundClosed();
    error RoundStillActive();
    error ChallengeAlreadySettled();
    error ResultExpired();
    error InvalidSignature();
    error IncorrectFee();
    error InvalidScore();
    error NoReward();
    error RewardAlreadyClaimed();
    error InsufficientAvailableBalance();
    error NativeTransferFailed();

    constructor(address resultSigner_, uint256 challengeFee_, uint256 poolShareBps_, uint256 rewardBps_, uint256 roundDuration_)
        payable EIP712("Monad Rug Arena", "1")
    {
        if (resultSigner_ == address(0) || challengeFee_ == 0 || poolShareBps_ > 10_000 || rewardBps_ == 0 || rewardBps_ > 10_000 || roundDuration_ == 0) {
            revert InvalidConfiguration();
        }
        resultSigner = resultSigner_;
        challengeFee = challengeFee_;
        poolShareBps = poolShareBps_;
        rewardBps = rewardBps_;
        roundDuration = roundDuration_;
        prizePool = msg.value;
        _startRound();
    }

    /// @notice Donations are testnet MON and are added to the actual shared prize pool.
    receive() external payable {
        prizePool += msg.value;
        _rounds[currentRoundId].prizePool = prizePool;
        emit PrizePoolUpdated(currentRoundId, prizePool);
    }

    /// @notice Anyone can reopen the arena once a winner is declared or the round expires.
    function startGameRound() external {
        GameRound storage previous = _rounds[currentRoundId];
        if (previous.active && block.timestamp < previous.endsAt) revert RoundStillActive();
        previous.active = false;
        _startRound();
    }

    function settleChallenge(ChallengeResult calldata result, bytes calldata signature) external payable {
        if (result.challengeId == bytes32(0) || result.transcriptHash == bytes32(0)) revert InvalidChallenge();
        if (_challenges[result.challengeId].settled) revert ChallengeAlreadySettled();
        if (msg.sender != result.player) revert WrongPlayer();
        if (result.roundId != currentRoundId) revert WrongRound();
        GameRound storage round = _rounds[currentRoundId];
        if (!round.active || block.timestamp >= round.endsAt) revert RoundClosed();
        if (block.timestamp > result.deadline) revert ResultExpired();
        if (msg.value != challengeFee) revert IncorrectFee();
        if (result.score != (result.success ? SUCCESS_SCORE : FAILURE_SCORE)) revert InvalidScore();
        (address recovered, ECDSA.RecoverError recoveryError,) = ECDSA.tryRecover(hashResult(result), signature);
        if (recoveryError != ECDSA.RecoverError.NoError || recovered != resultSigner) revert InvalidSignature();

        PlayerStats storage stats = _players[msg.sender];
        if (stats.attempts == 0) _playerAddresses.push(msg.sender);
        stats.attempts += 1;
        stats.score += result.score;
        totalChallenges += 1;
        prizePool += msg.value * poolShareBps / 10_000;

        uint256 reward;
        if (result.success) {
            stats.successes += 1;
            stats.wins += 1;
            round.active = false;
            round.winner = msg.sender;
            reward = prizePool * rewardBps / 10_000;
            // Prior winners' unclaimed balances can never be offered to a new winner.
            if (reward > address(this).balance - reservedRewards) revert InsufficientAvailableBalance();
            prizePool -= reward;
            reservedRewards += reward;
            round.reward = reward;
        }
        round.prizePool = prizePool;
        _challenges[result.challengeId] = ChallengeRecord({
            player: msg.sender, roundId: result.roundId, success: result.success,
            score: result.score, fee: msg.value, reward: reward,
            transcriptHash: result.transcriptHash, settledAt: block.timestamp, settled: true
        });
        emit ChallengeSettled(result.challengeId, msg.sender, result.roundId, result.success, result.score, msg.value, reward);
        emit PrizePoolUpdated(result.roundId, prizePool);
        if (result.success) emit WinnerDeclared(result.roundId, msg.sender, result.challengeId, reward);
    }

    /// @notice A winner may claim even after several later rounds have started.
    function claimReward(uint256 roundId) external nonReentrant {
        GameRound storage round = _rounds[roundId];
        if (round.winner != msg.sender || round.reward == 0) revert NoReward();
        if (round.rewardClaimed) revert RewardAlreadyClaimed();
        round.rewardClaimed = true;
        reservedRewards -= round.reward;
        (bool sent,) = payable(msg.sender).call{value: round.reward}("");
        if (!sent) revert NativeTransferFailed();
        emit RewardClaimed(roundId, msg.sender, round.reward);
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
