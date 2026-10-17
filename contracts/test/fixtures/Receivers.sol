// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {NativeVault} from "../../src/NativeVault.sol";
import {RugArena} from "../../src/RugArena.sol";

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

/// @dev A player contract exercises failed rewards and reentrant settlement callbacks.
contract ArenaPayer {
    RugArena public arena;
    bool public acceptsReward = true;
    bool public reentrySucceeded;
    bytes private nestedCall;

    function enter(RugArena target, bytes32 challengeId, uint256 roundId) external payable {
        arena = target;
        target.enterChallenge{value: msg.value}(challengeId, roundId);
    }

    function configureReward(bool accept, bytes calldata nested) external {
        acceptsReward = accept;
        nestedCall = nested;
    }

    receive() external payable {
        if (!acceptsReward) revert("NO_REWARD");
        if (nestedCall.length > 0) (reentrySucceeded,) = address(arena).call(nestedCall);
    }
}
