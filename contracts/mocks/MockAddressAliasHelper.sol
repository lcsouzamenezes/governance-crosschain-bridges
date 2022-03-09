//SPDX-License-Identifier: Unlicense
pragma solidity 0.7.5;

library MockAddressAliasHelper {
  address public giveBack;

  function setGiveBack (address _giveBack) external {
    giveBack = _giveBack;
  }

  function applyL1ToL2Alias(address l1Address) internal pure returns (address l2Address) {
    return giveBack;
  }

  function undoL1ToL2Alias(address l2Address) internal pure returns (address l1Address) {
    return giveBack;
  }
}
