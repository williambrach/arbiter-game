import { worlds } from './worlds.mjs';

// Coin and charge rules. Pure: no I/O. quote() never mutates; spend() changes only spent and charges.

const COSTS = { ask: 1, inspect: 3, continue: 2 };
const LABELS = { inspect: 'reasoning inspections', continue: 'conversations' };

// A game must be able to ask every agent once, in the largest registered world.
export const minimumBudget = () => COSTS.ask * Math.max(...Object.values(worlds).map(w => w.agents));

// Production games have no coin budget and no use limits: a question costs 1 coin, a reasoning inspection 3 and a talk round 2. A charge max of null means no use limit. Tests pass a budget to exercise the coin rules.
export function economyRules({ budget = null, inspect = null } = {}) {
  return { budget, costs: { ...COSTS }, charges: { inspect, continue: null } };
}

export function createWallet(rules) {
  const charges = {};
  for (const [tool, max] of Object.entries(rules.charges)) charges[tool] = { max, used: 0 };
  return { budget: rules.budget, spent: 0, costs: { ...rules.costs }, charges };
}

function assertKnown(wallet, tools) {
  for (const t of tools) {
    if (!Object.hasOwn(wallet.costs, t)) throw new Error(`Unknown tool: ${t}`);
  }
}

export function quote(wallet, tools, reserve) {
  assertKnown(wallet, tools);
  const cost = tools.reduce((sum, t) => sum + (wallet.costs[t] ?? 0), 0);
  for (const t of tools) {
    const c = wallet.charges[t];
    if (c && c.max != null && c.used >= c.max) return { cost, ok: false, reason: `No ${LABELS[t]} left.` };
  }
  if (wallet.budget == null) return { cost, ok: true, reason: null };
  const left = wallet.budget - wallet.spent;
  if (cost > left) {
    return { cost, ok: false, reason: `Not enough coins: this costs ${cost} and you have ${left} left.` };
  }
  if (left - cost < reserve) {
    return { cost, ok: false, reason: `Save coins: you need ${reserve} to ask everyone once.` };
  }
  return { cost, ok: true, reason: null };
}

export function spend(wallet, tools) {
  assertKnown(wallet, tools);
  const cost = tools.reduce((sum, t) => sum + (wallet.costs[t] ?? 0), 0);
  for (const t of tools) if (wallet.charges[t]) wallet.charges[t].used += 1;
  wallet.spent += cost;
  return { tools: [...tools], cost, total: wallet.spent };
}
