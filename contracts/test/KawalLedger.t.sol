// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KawalLedger} from "../src/KawalLedger.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes calldata) external;
}

/// No forge-std: plain requires, and the cheatcode address declared by hand.
contract KawalLedgerTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    KawalLedger ledger;
    address constant ANCHORER = address(0xA11CE);

    function setUp() public {
        vm.warp(20_000 days);
        ledger = new KawalLedger(ANCHORER);
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_anchorAndVerifyThreeLeaves() public {
        bytes32 a = ledger.leafOf("https://a.example/mcp", 1, true, 120, "mcp");
        bytes32 b = ledger.leafOf("https://b.example/a2a", 2, false, 8000, "a2a");
        bytes32 c = ledger.leafOf("https://a.example/mcp", 3, true, 90, "mcp");
        // Level one pairs a,b; c is carried up; the root pairs the two.
        bytes32 ab = hashPair(a, b);
        bytes32 root = hashPair(ab, c);

        vm.prank(ANCHORER);
        ledger.anchor(19_998, root, 3, 2, 1);

        bytes32[] memory proofA = new bytes32[](2);
        proofA[0] = b;
        proofA[1] = c;
        require(ledger.verify(19_998, a, proofA), "a should verify");

        bytes32[] memory proofC = new bytes32[](1);
        proofC[0] = ab;
        require(ledger.verify(19_998, c, proofC), "c should verify");

        proofC[0] = a;
        require(!ledger.verify(19_998, c, proofC), "a wrong proof must not verify");
        require(!ledger.verify(19_997, c, proofC), "an unanchored day verifies nothing");
        require(ledger.latestDay() == 19_998 && ledger.anchoredDays() == 1, "counters");
    }

    function test_dayIsWriteOnce() public {
        vm.prank(ANCHORER);
        ledger.anchor(19_998, bytes32(uint256(1)), 1, 1, 1);
        vm.prank(ANCHORER);
        vm.expectRevert(abi.encodeWithSelector(KawalLedger.AlreadyAnchored.selector, uint32(19_998)));
        ledger.anchor(19_998, bytes32(uint256(2)), 1, 1, 1);
    }

    function test_dayMustBeOver() public {
        vm.prank(ANCHORER);
        vm.expectRevert(abi.encodeWithSelector(KawalLedger.DayNotOver.selector, uint32(20_000)));
        ledger.anchor(20_000, bytes32(uint256(1)), 1, 1, 1);
    }

    function test_strangerCannotAnchor() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(KawalLedger.NotAnchorer.selector));
        ledger.anchor(19_998, bytes32(uint256(1)), 1, 1, 1);
    }

    function test_onlyOperatorRotatesAnchorer() public {
        vm.prank(ANCHORER);
        vm.expectRevert(abi.encodeWithSelector(KawalLedger.NotOperator.selector));
        ledger.setAnchorer(address(0xBAD));
        ledger.setAnchorer(address(0xB0B)); // this contract deployed it
        require(ledger.anchorer() == address(0xB0B), "rotated");
    }
}
