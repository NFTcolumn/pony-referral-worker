require('dotenv').config();
const ethers = require("ethers");

// Configuration
const PIXEL_PONY_V1_ADDRESS = process.env.PIXEL_PONY_V1_ADDRESS || "0x2B4652Bd6149E407E3F57190E25cdBa1FC9d37d8";
const REFERRAL_CONTRACT_ADDRESS = process.env.REFERRAL_CONTRACT_ADDRESS || "0x82249d29af7d7b1F20A63D7aa1248A40c58848e8";
const RPC_URL = process.env.BASE_MAINNET_RPC || "https://mainnet.base.org";
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY;
const START_BLOCK = parseInt(process.env.START_BLOCK || "0");

async function fetchEventsFromBasescan(contractAddress, topic0, fromBlock, toBlock) {
    // Use Etherscan V2 API with Base chainid (8453)
    const url = `https://api.etherscan.io/v2/api?chainid=8453&module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${contractAddress}&topic0=${topic0}&apikey=${BASESCAN_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "1") {
        console.error("Etherscan API response:", JSON.stringify(data, null, 2));
        throw new Error(`Etherscan API error: ${data.message || data.result}`);
    }

    return data.result;
}

async function checkReferralStats() {
    console.log("🔍 Checking Pixel Pony Referral Stats...\n");
    console.log(`   Network: Base Mainnet`);
    console.log(`   PixelPonyV1: ${PIXEL_PONY_V1_ADDRESS}`);
    console.log(`   Referral Contract: ${REFERRAL_CONTRACT_ADDRESS}\n`);

    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

        const pixelPonyABI = [
            "event RaceExecuted(uint256 indexed raceId, address indexed player, uint256 horseId, uint256[3] winners, uint256 payout, bool won)"
        ];

        const referralABI = [
            "function referrerOf(address player) external view returns (address)",
            "function hasReferrer(address player) external view returns (bool)",
            "function pendingRewards(address referrer) external view returns (uint256)",
            "function getStats() external view returns (uint256 _totalRewardsFunded, uint256 _totalRewardsClaimed, uint256 _totalReferrers, uint256 _contractBalance)",
            "function getReferrerInfo(address referrer) external view returns (uint256 pending, bool canClaim)",
            "event ReferrerSet(address indexed player, address indexed referrer)"
        ];

        const pixelPony = new ethers.Contract(PIXEL_PONY_V1_ADDRESS, pixelPonyABI, provider);
        const referral = new ethers.Contract(REFERRAL_CONTRACT_ADDRESS, referralABI, provider);

        // Get stats directly from the contract
        console.log("📊 Fetching contract stats...\n");
        const [totalRewardsFunded, totalRewardsClaimed, totalReferrersCount, contractBalance] = await referral.getStats();

        // Get list of all referrers by scanning ReferrerSet events via Basescan
        console.log("🔄 Finding all referrers via Basescan API...");
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = START_BLOCK || 0;

        // ReferrerSet event topic: keccak256("ReferrerSet(address,address)")
        const referrerSetTopic = "0x5f7165288eef601591cf549e15ff19ef9060b7f71b9c115be946fa1fe7ebf68a";

        const logs = await fetchEventsFromBasescan(
            REFERRAL_CONTRACT_ADDRESS,
            referrerSetTopic,
            fromBlock,
            currentBlock
        );

        console.log(`   Found ${logs.length} ReferrerSet events`);

        // Parse events using ethers
        const referralInterface = new ethers.utils.Interface([
            "event ReferrerSet(address indexed player, address indexed referrer)"
        ]);

        // Build referrer stats
        const referrerStats = new Map(); // referrer => { players: Set, pendingRewards: BigNumber, canClaim: boolean }

        for (const log of logs) {
            const parsed = referralInterface.parseLog(log);
            const { player, referrer } = parsed.args;

            if (!referrerStats.has(referrer)) {
                referrerStats.set(referrer, {
                    players: new Set(),
                    pendingRewards: ethers.BigNumber.from(0),
                    canClaim: false
                });
            }

            referrerStats.get(referrer).players.add(player);
        }

        // Get pending rewards for each referrer
        console.log("💰 Fetching pending rewards...\n");
        for (const [referrerAddress, stats] of referrerStats.entries()) {
            const [pending, canClaim] = await referral.getReferrerInfo(referrerAddress);
            stats.pendingRewards = pending;
            stats.canClaim = canClaim;
        }

        // Calculate totals
        let totalPlayersWithRefs = 0;
        for (const stats of referrerStats.values()) {
            totalPlayersWithRefs += stats.players.size;
        }

        // Display results
        console.log("=" .repeat(80));
        console.log("📈 REFERRAL CONTRACT STATISTICS");
        console.log("=" .repeat(80));
        console.log(`Total Referrers:             ${totalReferrersCount.toString()}`);
        console.log(`Unique Players with Refs:    ${totalPlayersWithRefs}`);
        console.log(`Total Rewards Funded:        ${ethers.utils.formatEther(totalRewardsFunded)} ETH`);
        console.log(`Total Rewards Claimed:       ${ethers.utils.formatEther(totalRewardsClaimed)} ETH`);
        console.log(`Contract Balance:            ${ethers.utils.formatEther(contractBalance)} ETH`);
        console.log(`Unclaimed Rewards:           ${ethers.utils.formatEther(totalRewardsFunded.sub(totalRewardsClaimed))} ETH`);
        console.log("=" .repeat(80));

        if (referrerStats.size > 0) {
            console.log("\n👥 REFERRER BREAKDOWN:\n");

            // Sort by pending rewards (highest first)
            const sortedReferrers = Array.from(referrerStats.entries())
                .sort((a, b) => b[1].pendingRewards.gt(a[1].pendingRewards) ? 1 : -1);

            for (const [referrerAddress, stats] of sortedReferrers) {
                console.log(`📍 Referrer: ${referrerAddress}`);
                console.log(`   Unique Players Referred: ${stats.players.size}`);
                console.log(`   Pending Rewards:         ${ethers.utils.formatEther(stats.pendingRewards)} ETH`);
                console.log(`   Can Claim:               ${stats.canClaim ? "✅ Yes" : "❌ No (below minimum)"}`);
                console.log();
            }
        } else {
            console.log("\n⚠️  No referrers found in the scanned block range.");
            console.log("   Try setting START_BLOCK to an earlier block number in your .env file");
        }

    } catch (error) {
        console.error("\n❌ Error checking referral stats:");
        console.error(error.message);
        if (error.error?.message) {
            console.error("Revert reason:", error.error.message);
        }
    }
}

// Run the check
checkReferralStats().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
