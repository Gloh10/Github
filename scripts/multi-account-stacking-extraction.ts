// Quantifies the "run the same strategy across multiple accounts" lever.
// Since every account follows the SAME underlying trade sequence (not independent
// draws -- it's literally the same market), expected value still scales linearly by
// linearity of expectation, but risk does NOT diversify away: a bad stretch busts
// every account together, and the dollar loss (eval fees) scales with account count
// too. This script just does the arithmetic cleanly against the realistic
// (forced-exit-corrected) single-account figures already established this session.

interface FirmPlan {
  firm: string;
  maxAccounts: number;
  aggregatePayoutCap: number | null; // lifetime cap across ALL accounts combined, if any
  singleAccountExpectedExtraction: number; // realistic, forced-exit-corrected, per Monte Carlo
  singleAccountBustRate: number; // %
  evalFeeList: number;
  evalFeePromo: number | null; // typical/commonly-available promo price, if known
  activationFee: number; // paid once, only on clearing the eval
  clearRate: number; // % -- used to weight expected activation-fee cost
  note: string;
}

const PLANS: FirmPlan[] = [
  {
    firm: "Apex 150K (Intraday, promo-eligible)",
    maxAccounts: 20,
    aggregatePayoutCap: null,
    singleAccountExpectedExtraction: 2837,
    singleAccountBustRate: 0.1,
    evalFeeList: 599,
    evalFeePromo: 599 * 0.5, // Apex publishes 50-90% off promos "nearly year-round" -- using a conservative 50% as the promo case
    activationFee: 129,
    clearRate: 99.9,
    note: "20-account household cap, no aggregate payout cap found. Copy trading across own accounts explicitly permitted (same direction/time, no hedging).",
  },
  {
    firm: "LucidFlex 150K",
    maxAccounts: 5,
    aggregatePayoutCap: null,
    singleAccountExpectedExtraction: 2484,
    singleAccountBustRate: 0.5,
    evalFeeList: 407,
    evalFeePromo: 295.4, // verified via the user's own screenshot -- an active promo price, not a generic estimate
    activationFee: 0,
    clearRate: 99.6,
    note: "5 funded accounts max (10 total incl. evals). No aggregate payout cap found. Hedging across accounts banned -- not relevant since we're not hedging.",
  },
  {
    firm: "MyFundedFutures Pro 150K",
    maxAccounts: 3, // published cap: up to 3 accounts at the $100K/$150K tier
    aggregatePayoutCap: 100_000, // lifetime, ALL accounts combined, per-user
    singleAccountExpectedExtraction: 3617,
    singleAccountBustRate: 3.9,
    evalFeeList: 557,
    evalFeePromo: null,
    activationFee: 0,
    clearRate: 97.8,
    note: "Max 3 accounts at 150K tier (10 total across all tiers). $100,000 LIFETIME payout cap across every account combined -- doesn't bind yet at this extraction scale, but will eventually.",
  },
];

function costPerAccount(plan: FirmPlan, usePromo: boolean): number {
  const eval_ = usePromo && plan.evalFeePromo !== null ? plan.evalFeePromo : plan.evalFeeList;
  const expectedActivation = plan.activationFee * (plan.clearRate / 100);
  return eval_ + expectedActivation;
}

function main() {
  console.log("=".repeat(110));
  console.log("MULTI-ACCOUNT STACKING -- running the same signals across N accounts of the same firm");
  console.log("=".repeat(110));
  console.log("IMPORTANT: this is NOT diversification. Every account follows the same real trade sequence,");
  console.log("so expected value scales ~linearly with account count, but so does the correlated bust risk --");
  console.log("a bad stretch loses eval fees across every account at once, not just a random fraction of them.\n");

  for (const plan of PLANS) {
    console.log("-".repeat(110));
    console.log(plan.firm);
    console.log("-".repeat(110));
    console.log(`Single account: expected extraction $${plan.singleAccountExpectedExtraction.toLocaleString()}, bust rate ${plan.singleAccountBustRate}%`);
    console.log(`Note: ${plan.note}`);

    for (const usePromo of plan.evalFeePromo !== null ? [false, true] : [false]) {
      const perAccountCost = costPerAccount(plan, usePromo);
      console.log(`\n  ${usePromo ? "Promo pricing" : "List pricing"} -- cost per account (eval + expected activation): $${perAccountCost.toFixed(0)}`);
      console.log(`  Accounts   GrossExtraction   TotalCost     NetExtraction   (capped by aggregate limit? )`);
      for (const n of [1, 3, 5, 10, 20]) {
        if (n > plan.maxAccounts) continue;
        let gross = n * plan.singleAccountExpectedExtraction;
        let cappedNote = "";
        if (plan.aggregatePayoutCap !== null && gross > plan.aggregatePayoutCap) {
          cappedNote = ` -- CAPPED at $${plan.aggregatePayoutCap.toLocaleString()} lifetime`;
          gross = plan.aggregatePayoutCap;
        }
        const totalCost = n * perAccountCost;
        const net = gross - totalCost;
        console.log(`  ${String(n).padStart(8)}   $${gross.toFixed(0).padStart(14)}   $${totalCost.toFixed(0).padStart(8)}   $${net.toFixed(0).padStart(12)}${cappedNote}`);
      }
    }
    console.log("");
  }

  console.log("=".repeat(110));
  console.log("RANKED -- net extraction at each firm's MAX allowed account count");
  console.log("=".repeat(110));
  const summary = PLANS.map((plan) => {
    const usePromo = plan.evalFeePromo !== null;
    const perAccountCost = costPerAccount(plan, usePromo);
    const n = plan.maxAccounts;
    let gross = n * plan.singleAccountExpectedExtraction;
    if (plan.aggregatePayoutCap !== null) gross = Math.min(gross, plan.aggregatePayoutCap);
    const net = gross - n * perAccountCost;
    return { firm: plan.firm, maxAccounts: n, net, pricingUsed: usePromo ? "promo" : "list" };
  });
  summary
    .sort((a, b) => b.net - a.net)
    .forEach((s, i) => console.log(`${i + 1}. ${s.firm.padEnd(38)} ${String(s.maxAccounts).padStart(2)} accounts (${s.pricingUsed} pricing)   net = $${s.net.toFixed(0)}`));
}

main();
