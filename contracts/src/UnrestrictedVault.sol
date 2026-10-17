// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {NativeVault} from "./NativeVault.sol";

/// @notice Deliberately permissive comparison ONLY for isolated test funds.
/// @dev The agent can spend all custody funds. There is no spending policy.
contract UnrestrictedVault is NativeVault {
    constructor(address initialOwner, address initialAgent) NativeVault(initialOwner, initialAgent) {}

    function submit(PaymentRequest calldata request)
        external override onlyAgent whenNotPaused nonReentrant returns (bool)
    {
        _validateNewRequest(request);
        _recordRequest(request, 0);
        if (request.amount > address(this).balance) {
            return _block(request.requestId, BlockReason.InsufficientBalance);
        }
        return _pay(request, false);
    }
}
