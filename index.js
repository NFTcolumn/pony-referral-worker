require('dotenv').config();
const ethers = require("ethers");

// Configuration
const PIXEL_PONY_V1_ADDRESS = process.env.PIXEL_PONY_V1_ADDRESS || "0x2B4652Bd6149E407E3F57190E25cdBa1FC9d37d8";
const REFERRAL_CONTRACT_ADDRESS = process.env.REFERRAL_CONTRACT_ADDRESS || "0x82249d29af7d7b1F20A63D7aa1248A40c58848e8";
const RPC_URL = process.env.BASE_MAINNET_RPC || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "3600000"); // 1 hour in ms
const REWARD_PER_RACE = ethers.utils.parseEther("0.00005");
const MAX_BLOCK_RANGE = parseInt(process.env.MAX_BLOCK_RANGE || "2000"); // Limit block range to avoid RPC timeouts
const INITIAL_BLOCK_LOOKBACK = parseInt(process.env.INITIAL_BLOCK_LOOKBACK || "200"); // ~7 minutes on Base (2s per block)
const MAX_RETRIES = 3;

// State tracking
let lastProcessedBlock = parseInt(process.env.START_BLOCK || "0");

async function initContracts() {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    const pixelPonyABI = [
        "event RaceExecuted(uint256 indexed raceId, address indexed player, uint256 horseId, uint256[3] winners, uint256 payout, bool won)"
    ];

    const referralABI = [
        "function referrerOf(address player) external view returns (address)",
        "function hasReferrer(address player) external view returns (bool)",
        "function pendingRewards(address referrer) external view returns (uint256)",
        "function fundRewards(address[] calldata referrers, uint256[] calldata amounts) external payable",
        "function owner() external view returns (address)"
    ];

    const pixelPony = new ethers.Contract(PIXEL_PONY_V1_ADDRESS, pixelPonyABI, provider);
    const referral = new ethers.Contract(REFERRAL_CONTRACT_ADDRESS, referralABI, wallet);

    return { provider, wallet, pixelPony, referral };
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            const delay = Math.pow(2, i) * 1000; // Exponential backoff: 1s, 2s, 4s
            console.log(`   ⚠️  Retry ${i + 1}/${retries} after ${delay}ms...`);
            await sleep(delay);
        }
    }
}

async function trackAndFundReferrals() {
    console.log(`\n[${new Date().toISOString()}] 🔍 Checking for new referrals...`);

    try {
        const { provider, wallet, pixelPony, referral } = await initContracts();

        // Get current block with retry
        const currentBlock = await retryWithBackoff(() => provider.getBlockNumber());

        // Limit scan range to avoid RPC timeouts
        // On first run, only look back a short time (INITIAL_BLOCK_LOOKBACK blocks)
        // On subsequent runs, scan from last processed block
        let fromBlock = lastProcessedBlock === 0 ? currentBlock - INITIAL_BLOCK_LOOKBACK : lastProcessedBlock + 1;
        const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE, currentBlock);

        console.log(`📊 Scanning blocks ${fromBlock} to ${toBlock}...`);

        if (toBlock < currentBlock) {
            console.log(`   ℹ️  ${currentBlock - toBlock} blocks remaining (will catch up gradually)`);
        }

        // Query RaceExecuted events with retry
        const filter = pixelPony.filters.RaceExecuted();
        const events = await retryWithBackoff(() => pixelPony.queryFilter(filter, fromBlock, toBlock));

        if (events.length === 0) {
            console.log("✅ No new races found");
            lastProcessedBlock = toBlock;
            return;
        }

        console.log(`Found ${events.length} new races`);

        // Track referrals: referrer => { raceCount, totalReward }
        const referralData = new Map();
        let totalReferredRaces = 0;

        for (const event of events) {
            const { player } = event.args;

            // Check if player has a referrer
            const hasRef = await referral.hasReferrer(player);

            if (hasRef) {
                const referrerAddress = await referral.referrerOf(player);
                totalReferredRaces++;

                if (!referralData.has(referrerAddress)) {
                    referralData.set(referrerAddress, {
                        raceCount: 0,
                        totalReward: ethers.BigNumber.from(0)
                    });
                }

                const data = referralData.get(referrerAddress);
                data.raceCount++;
                data.totalReward = data.totalReward.add(REWARD_PER_RACE);
            }
        }

        if (referralData.size === 0) {
            console.log("✅ No referred races found");
            lastProcessedBlock = toBlock;
            return;
        }

        console.log(`\n💰 Found ${totalReferredRaces} referred races for ${referralData.size} referrers`);

        // Check what's already funded and calculate unfunded amounts
        const referrersToFund = [];
        const amountsToFund = [];
        let totalToFund = ethers.BigNumber.from(0);

        for (const [referrerAddress, data] of referralData.entries()) {
            const currentPending = await referral.pendingRewards(referrerAddress);
            const totalOwed = data.totalReward;

            // Only fund the NEW races (difference between what they earned and what's already funded)
            const unfunded = totalOwed.gt(currentPending) ? totalOwed.sub(currentPending) : ethers.BigNumber.from(0);

            if (unfunded.gt(0)) {
                referrersToFund.push(referrerAddress);
                amountsToFund.push(unfunded);
                totalToFund = totalToFund.add(unfunded);

                console.log(`  📍 ${referrerAddress}`);
                console.log(`     New Races: ${data.raceCount}`);
                console.log(`     To Fund: ${ethers.utils.formatEther(unfunded)} ETH`);
            }
        }

        if (referrersToFund.length === 0) {
            console.log("✅ All referrers already funded");
            lastProcessedBlock = toBlock;
            return;
        }

        // Check wallet balance
        const balance = await wallet.getBalance();
        console.log(`\n💳 Wallet balance: ${ethers.utils.formatEther(balance)} ETH`);
        console.log(`💸 Total to fund: ${ethers.utils.formatEther(totalToFund)} ETH`);

        if (balance.lt(totalToFund)) {
            console.error("❌ Insufficient balance to fund rewards!");
            console.error(`   Need: ${ethers.utils.formatEther(totalToFund)} ETH`);
            console.error(`   Have: ${ethers.utils.formatEther(balance)} ETH`);
            return;
        }

        // Fund rewards
        console.log("\n📤 Funding rewards...");
        const tx = await referral.fundRewards(referrersToFund, amountsToFund, {
            value: totalToFund,
            gasLimit: 500000
        });

        console.log(`   Tx hash: ${tx.hash}`);
        console.log("   Waiting for confirmation...");

        const receipt = await tx.wait();

        console.log(`\n✅ Rewards funded successfully!`);
        console.log(`   Block: ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
        console.log(`   Funded ${referrersToFund.length} referrers with ${ethers.utils.formatEther(totalToFund)} ETH`);

        // Update last processed block
        lastProcessedBlock = toBlock;

    } catch (error) {
        console.error("\n❌ Error tracking/funding referrals:");
        console.error(error.message);
        if (error.error?.message) {
            console.error("Revert reason:", error.error.message);
        }
    }
}

async function runWorker() {
    console.log("🚀 Pixel Pony Referral Worker Starting...");
    console.log(`   Network: Base Mainnet`);
    console.log(`   PixelPonyV1: ${PIXEL_PONY_V1_ADDRESS}`);
    console.log(`   Referral Contract: ${REFERRAL_CONTRACT_ADDRESS}`);
    console.log(`   Check Interval: ${CHECK_INTERVAL / 1000 / 60} minutes`);
    console.log(`   Reward per race: 0.00005 ETH`);

    if (!PRIVATE_KEY) {
        console.error("\n❌ MAINNET_PRIVATE_KEY not set in environment!");
        process.exit(1);
    }

    // Initial check
    await trackAndFundReferrals();

    console.log("\n✅ Worker running. Will check every", CHECK_INTERVAL / 1000 / 60, "minutes");
    console.log(`   Next check at: ${new Date(Date.now() + CHECK_INTERVAL).toISOString()}`);

    // Set up interval
    setInterval(async () => {
        console.log(`\n⏰ Interval triggered at ${new Date().toISOString()}`);
        await trackAndFundReferrals();
        console.log(`   Next check at: ${new Date(Date.now() + CHECK_INTERVAL).toISOString()}`);
    }, CHECK_INTERVAL);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n⚠️  SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n⚠️  SIGINT received, shutting down gracefully...');
    process.exit(0);
});

// Start the worker
runWorker().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
