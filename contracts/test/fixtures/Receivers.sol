// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {NativeVault} from "../../src/NativeVault.sol";

contract RejectingReceiver {
    receive() external payable { revert("NO_THANKS"); }
}

/// @dev Deliberately also used as the agent, so a reentrant call really passes
///      onlyAgent and tests the vault's guard instead of just an address check.
contract ReentrantAgent {
    NativeVault public target;
    bytes private nestedCall;
    bool public reentrySucceeded;

    function attack(NativeVault vault, NativeVault.PaymentRequest calldata outer, bytes calldata nested) external {
        target = vault;
        nestedCall = nested;
        vault.submit(outer);
    }

    receive() external payable {
        (reentrySucceeded,) = address(target).call(nestedCall);
    }
}
