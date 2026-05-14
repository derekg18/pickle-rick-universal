import type { Backend } from '../../types/index.js';

export type TokenSource = Backend | 'unknown';
export type TokenCostConfidence = 'exact' | 'estimated' | 'unknown';

export interface TokenUsageRecord {
  source: TokenSource;
  backend?: Backend;
  source_path?: string;
  timestamp?: string;
  model?: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_confidence: TokenCostConfidence;
  notes?: string[];
}

export interface TokenUsageTotals {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

export interface TokenUsageSummary {
  generated_at: string;
  session_dir: string;
  records: TokenUsageRecord[];
  totals: TokenUsageTotals;
  cost_confidence: TokenCostConfidence;
  pricing_table_updated_at: string | null;
  artifacts: {
    json: string;
    markdown: string;
  };
}

export interface BackendParserResult {
  records: TokenUsageRecord[];
  warnings: string[];
}

export interface TokenAccountingArtifacts {
  summary: TokenUsageSummary;
  jsonPath: string;
  markdownPath: string;
}
