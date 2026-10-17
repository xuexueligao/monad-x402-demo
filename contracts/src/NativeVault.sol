// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Shared native-MON custody and receipts. No fees, rounds or scoring.
abstract contract NativeVault is Ownable2Step, Pausable, ReentrancyGuard {
    struct PaymentRequest {
        bytes32 requestId;
        address payable recipient;
        uint256 amount;
        bytes32 contextHash;
        uint64 deadline;
    }

    enum Outcome { Unseen, Blocked, Paid }
    enum BlockReason {
        None,
        RecipientNotAllowed,
        SingleLimitExceeded,
        WindowBudgetExceeded,
        InsufficientBalance
    }

    struct RequestRecord {
        bytes32 intentHash;
        uint64 policyVersion;
        Outcome outcome;
        BlockReason reason;
    }

    error InvalidAgent();
    error OwnerCannotBeAgent();
    error OwnershipRenunciationDisabled();
    error UnauthorizedAgent(address caller);
    error InvalidRequestId();
    error InvalidRecipient();
    error InvalidAmount();
    error RequestExpired();
    error RequestAlreadyProcessed(bytes32 requestId);
    error NativeTransferFailed(bytes32 requestId);

    event Deposited(address indexed sender, uint256 amount);
    event AgentChanged(address indexed previousAgent, address indexed newAgent);
    event PaymentRequested(
        bytes32 indexed requestId,
        bytes32 indexed intentHash,
        address indexed recipient,
        uint256 amount,
        bytes32 contextHash,
        uint64 deadline,
        uint64 policyVersion
    );
    event PaymentBlocked(bytes32 indexed requestId, BlockReason indexed reason);
    event PaymentExecuted(
        bytes32 indexed requestId,
        address indexed recipient,
        uint256 amount,
        bool ownerApproved
    );

    address public agent;
    mapping(bytes32 => RequestRecord) public requests;
    uint256 public requestCount;
    uint256 public blockedCount;
    uint256 public executedCount;
    uint256 public ownerApprovedCount;
    uint256 public totalPaid;

    bytes32 private constant REQUEST_TYPEHASH = keccak256(
        "PaymentRequest(uint256 chainId,address vault,bytes32 requestId,address recipient,uint256 amount,bytes32 contextHash,uint64 deadline)"
    );

    constructor(address initialOwner, address initialAgent) Ownable(initialOwner) {
        _setAgent(initialAgent);
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert UnauthorizedAgent(msg.sender);
        _;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function setAgent(address newAgent) external onlyOwner {
        _setAgent(newAgent);
        _authorityChanged();
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @dev Prevent accidentally abandoning custody with no recovery authority.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /// @dev A pending owner must not receive the agent key during a handover.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == agent) revert OwnerCannotBeAgent();
        super.transferOwnership(newOwner);
    }

    function hashRequest(PaymentRequest calldata request) public view returns (bytes32) {
        return keccak256(abi.encode(
            REQUEST_TYPEHASH, block.chainid, address(this), request.requestId,
            request.recipient, request.amount, request.contextHash, request.deadline
        ));
    }

    function submit(PaymentRequest calldata request) external virtual returns (bool paid);

    function _setAgent(address newAgent) private {
        if (newAgent == address(0)) revert InvalidAgent();
        if (newAgent == owner() || newAgent == pendingOwner()) revert OwnerCannotBeAgent();
        address previous = agent;
        agent = newAgent;
        emit AgentChanged(previous, newAgent);
    }

    function _transferOwnership(address newOwner) internal override {
        if (newOwner == agent && agent != address(0)) revert OwnerCannotBeAgent();
        super._transferOwnership(newOwner);
        _authorityChanged();
    }

    function _authorityChanged() internal virtual {}

    function _validatePayload(PaymentRequest calldata request) internal view {
        if (request.requestId == bytes32(0)) revert InvalidRequestId();
        if (request.recipient == address(0) || request.recipient == address(this)) revert InvalidRecipient();
        if (request.amount == 0) revert InvalidAmount();
        if (request.deadline < block.timestamp) revert RequestExpired();
    }

    function _validateNewRequest(PaymentRequest calldata request) internal view {
        _validatePayload(request);
        if (requests[request.requestId].outcome != Outcome.Unseen) {
            revert RequestAlreadyProcessed(request.requestId);
        }
    }

    function _recordRequest(PaymentRequest calldata request, uint64 version) internal {
        bytes32 intentHash = hashRequest(request);
        requests[request.requestId] = RequestRecord(intentHash, version, Outcome.Unseen, BlockReason.None);
        ++requestCount;
        emit PaymentRequested(
            request.requestId, intentHash, request.recipient, request.amount,
            request.contextHash, request.deadline, version
        );
    }

    function _block(bytes32 requestId, BlockReason reason) internal returns (bool) {
        requests[requestId].outcome = Outcome.Blocked;
        requests[requestId].reason = reason;
        ++blockedCount;
        emit PaymentBlocked(requestId, reason);
        return false;
    }

    function _pay(PaymentRequest calldata request, bool ownerApproved) internal returns (bool) {
        requests[request.requestId].outcome = Outcome.Paid;
        requests[request.requestId].reason = BlockReason.None;
        ++executedCount;
        totalPaid += request.amount;
        if (ownerApproved) ++ownerApprovedCount;
        _accountPayment(request.amount);
        // ReentrancyGuard covers both entry points; a recipient cannot replay
        // a request or execute a different one before accounting is committed.
        (bool ok,) = request.recipient.call{value: request.amount}("");
        if (!ok) revert NativeTransferFailed(request.requestId);
        emit PaymentExecuted(request.requestId, request.recipient, request.amount, ownerApproved);
        return true;
    }

    function _accountPayment(uint256 amount) internal virtual {}
}
