// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {NativeVault} from "./NativeVault.sol";

/// @notice An agent may propose native-MON transfers; chain rules authorize them.
/// @dev Fixed UTC-aligned windows, NOT rolling windows. No arbitrary calldata,
///      token approvals, delegatecall, upgrade hook or agent-controlled owner.
contract PolicyVault is NativeVault {
    error InvalidLimits();
    error InvalidWindow();
    error NotBlockedRequest();
    error IntentMismatch();
    error StalePolicy(uint64 expected, uint64 actual);
    error InsufficientFunds();

    event PolicyChanged(uint64 indexed version, uint256 maxPerPayment, uint256 windowBudget);
    event RecipientPermissionChanged(address indexed recipient, bool allowed, uint64 version);
    event OwnerApprovalUsed(bytes32 indexed requestId, bytes32 indexed intentHash, uint64 policyVersion);

    uint256 public maxPerPayment;
    uint256 public windowBudget;
    uint64 public immutable windowSeconds;
    uint64 public policyVersion = 1;
    mapping(address => bool) public recipientAllowed;
    mapping(uint256 => uint256) public spentInWindow;

    constructor(
        address initialOwner,
        address initialAgent,
        uint256 initialMaxPerPayment,
        uint256 initialWindowBudget,
        uint64 initialWindowSeconds
    ) NativeVault(initialOwner, initialAgent) {
        if (initialWindowSeconds == 0) revert InvalidWindow();
        windowSeconds = initialWindowSeconds;
        _setLimits(initialMaxPerPayment, initialWindowBudget);
        emit PolicyChanged(policyVersion, maxPerPayment, windowBudget);
    }

    function currentWindow() public view returns (uint256) {
        return block.timestamp / windowSeconds;
    }

    function remainingBudget() external view returns (uint256) {
        uint256 spent = spentInWindow[currentWindow()];
        return spent >= windowBudget ? 0 : windowBudget - spent;
    }

    /// @notice Changing a policy never resets the amount already spent.
    function setLimits(uint256 newMaxPerPayment, uint256 newWindowBudget) external onlyOwner {
        _setLimits(newMaxPerPayment, newWindowBudget);
        _bumpVersion();
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        recipientAllowed[recipient] = allowed;
        _bumpVersion();
        emit RecipientPermissionChanged(recipient, allowed, policyVersion);
    }

    /// @notice A preview is an estimate, not a reservation or approval.
    function preview(PaymentRequest calldata request) external view whenNotPaused returns (BlockReason) {
        _validateNewRequest(request);
        return _evaluate(request);
    }

    /// @notice A policy denial succeeds as a TRANSACTION and emits PaymentBlocked.
    ///         It returns false and transfers no value. A receipt's status alone
    ///         therefore cannot be used to decide whether money moved.
    function submit(PaymentRequest calldata request)
        external override onlyAgent whenNotPaused nonReentrant returns (bool)
    {
        _validateNewRequest(request);
        _recordRequest(request, policyVersion);
        BlockReason reason = _evaluate(request);
        if (reason != BlockReason.None) return _block(request.requestId, reason);
        return _pay(request, false);
    }

    /// @notice Owner signs this exact transaction to approve ONE blocked request.
    ///         It may override whitelist and caps, but not pause, expiry, balance,
    ///         payload binding, policy version or replay protection. Approved
    ///         payments also consume the current window's budget.
    function approveAndExecute(PaymentRequest calldata request, uint64 expectedPolicyVersion)
        external onlyOwner whenNotPaused nonReentrant returns (bool)
    {
        _validatePayload(request);
        RequestRecord memory record = requests[request.requestId];
        if (record.outcome != Outcome.Blocked) revert NotBlockedRequest();
        if (record.intentHash != hashRequest(request)) revert IntentMismatch();
        if (expectedPolicyVersion != policyVersion) revert StalePolicy(expectedPolicyVersion, policyVersion);
        if (record.policyVersion != policyVersion) revert StalePolicy(record.policyVersion, policyVersion);
        if (request.amount > address(this).balance) revert InsufficientFunds();
        emit OwnerApprovalUsed(request.requestId, record.intentHash, policyVersion);
        return _pay(request, true);
    }

    function _evaluate(PaymentRequest calldata request) private view returns (BlockReason) {
        if (!recipientAllowed[request.recipient]) return BlockReason.RecipientNotAllowed;
        if (request.amount > maxPerPayment) return BlockReason.SingleLimitExceeded;
        uint256 spent = spentInWindow[currentWindow()];
        if (spent >= windowBudget || request.amount > windowBudget - spent) {
            return BlockReason.WindowBudgetExceeded;
        }
        if (request.amount > address(this).balance) return BlockReason.InsufficientBalance;
        return BlockReason.None;
    }

    function _accountPayment(uint256 amount) internal override {
        spentInWindow[currentWindow()] += amount;
    }

    function _setLimits(uint256 paymentLimit, uint256 budget) private {
        if (paymentLimit == 0 || budget == 0 || paymentLimit > budget) revert InvalidLimits();
        maxPerPayment = paymentLimit;
        windowBudget = budget;
    }

    function _bumpVersion() private {
        ++policyVersion;
        emit PolicyChanged(policyVersion, maxPerPayment, windowBudget);
    }

    function _authorityChanged() internal override {
        _bumpVersion();
    }
}
