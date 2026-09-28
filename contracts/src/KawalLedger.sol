// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KawalLedger
/// @notice Kawal's probe history, anchored one UTC day at a time.
///
/// Kawal keeps every call it makes to an agent's endpoint in its own
/// database, and a database row is something its owner can rewrite. This
/// contract is where that stops being true: once a day is over, the Merkle
/// root of that day's probes is written here, and a day can be written once.
/// Anyone holding the day's rows (Kawal serves them at /api/anchor/{day})
/// can rebuild the root and compare, or check a single probe with `verify`.
///
/// Leaf: keccak256(bytes.concat(keccak256(abi.encode(
///   string endpoint, uint64 checkedAt, bool answered, uint32 latencyMs, string protocol))))
/// Tree: sorted-pair keccak256, an odd node carried up unchanged.
contract KawalLedger {
    struct Anchor {
        bytes32 root;
        uint32 probes;
        uint32 endpoints;
        uint32 answered;
        uint64 anchoredAt;
        uint64 blockNumber;
    }

    /// The wallet that deployed this; the only one that may change who anchors.
    address public immutable operator;
    /// The key allowed to write roots. Separate from the operator so a hot key
    /// on a server can anchor without holding any other authority.
    address public anchorer;

    /// UTC day number (unix seconds / 86400) to its anchor.
    mapping(uint32 => Anchor) public anchors;
    uint32 public latestDay;
    uint32 public anchoredDays;

    event Anchored(uint32 indexed day, bytes32 root, uint32 probes, uint32 endpoints, uint32 answered);
    event AnchorerChanged(address indexed previous, address indexed next);

    error NotOperator();
    error NotAnchorer();
    error EmptyRoot();
    error DayNotOver(uint32 day);
    error AlreadyAnchored(uint32 day);

    constructor(address anchorer_) {
        operator = msg.sender;
        anchorer = anchorer_;
        emit AnchorerChanged(address(0), anchorer_);
    }

    function setAnchorer(address next) external {
        if (msg.sender != operator) revert NotOperator();
        emit AnchorerChanged(anchorer, next);
        anchorer = next;
    }

    /// Writes one finished day's root. Write-once: a second call for the same
    /// day reverts, which is the whole guarantee.
    function anchor(uint32 day, bytes32 root, uint32 probes, uint32 endpoints, uint32 answered) external {
        if (msg.sender != anchorer && msg.sender != operator) revert NotAnchorer();
        if (root == bytes32(0)) revert EmptyRoot();
        if ((uint256(day) + 1) * 1 days > block.timestamp) revert DayNotOver(day);
        if (anchors[day].root != bytes32(0)) revert AlreadyAnchored(day);

        anchors[day] = Anchor(root, probes, endpoints, answered, uint64(block.timestamp), uint64(block.number));
        if (day > latestDay) latestDay = day;
        anchoredDays += 1;
        emit Anchored(day, root, probes, endpoints, answered);
    }

    /// Whether `leaf` is one of the probes in `day`'s anchored root.
    function verify(uint32 day, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = anchors[day].root;
        if (root == bytes32(0)) return false;
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sib = proof[i];
            node = node < sib ? keccak256(abi.encodePacked(node, sib)) : keccak256(abi.encodePacked(sib, node));
        }
        return node == root;
    }

    /// The leaf for one probe, so a reader can hash a row without writing the encoding.
    function leafOf(string calldata endpoint, uint64 checkedAt, bool answered, uint32 latencyMs, string calldata protocol)
        external
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(endpoint, checkedAt, answered, latencyMs, protocol))));
    }
}
