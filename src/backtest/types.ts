export interface Bar {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Direction = "long" | "short";

export interface Signal {
  barIndex: number;
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  reason: string;
}

export interface Trade extends Signal {
  exitBarIndex: number;
  exitPrice: number;
  outcome: "win" | "loss";
  rMultiple: number;
}

export interface EquityPoint {
  t: number;
  equity: number; // normalized, starts at 100
}

export interface StrategyResult {
  strategyName: string;
  trades: Trade[];
  equityCurve: EquityPoint[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgR: number;
    totalR: number;
    maxDrawdownPct: number;
    finalEquity: number;
  };
}
