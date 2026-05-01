import { type KnownCategory } from './council-schema.js';

export type StackTier = 'xs' | 's' | 'm' | 'l' | 'xl' | 'xxl';

export type SubagentSpec = {
  category: KnownCategory;
  branch: string | null;
  prompt_vars: {
    stack_tier: StackTier;
    codex_enabled: boolean;
    has_migration_journal: boolean;
    target_branch: string | null;
  };
};

const UNCONDITIONAL_B_CATEGORIES: readonly KnownCategory[] = [
  'B1_stack_structure',
  'B2_claude_md',
  'B3_contract_discovery',
  'B4_cross_branch',
  'B5_test_coverage',
  'B6_security',
  'B8_szechuan',
  'B9_polish',
];

const SHARDED_TIERS = new Set<StackTier>(['l', 'xl', 'xxl']);

export function planFanOut(input: {
  stackTier: StackTier;
  branches: string[];
  codexEnabled: boolean;
  hasMigrationJournal: boolean;
}): SubagentSpec[] {
  const { stackTier, branches, codexEnabled, hasMigrationJournal } = input;
  const sharded = SHARDED_TIERS.has(stackTier);
  const specs: SubagentSpec[] = [];

  function makeSpec(category: KnownCategory, branch: string | null): SubagentSpec {
    return {
      category,
      branch,
      prompt_vars: {
        stack_tier: stackTier,
        codex_enabled: codexEnabled,
        has_migration_journal: hasMigrationJournal,
        target_branch: branch,
      },
    };
  }

  if (sharded) {
    for (const branch of branches) {
      for (const cat of UNCONDITIONAL_B_CATEGORIES) {
        specs.push(makeSpec(cat, branch));
      }
    }
  } else {
    for (const cat of UNCONDITIONAL_B_CATEGORIES) {
      specs.push(makeSpec(cat, null));
    }
  }

  if (hasMigrationJournal) {
    specs.push(makeSpec('B7_migration_hygiene', null));
  }

  for (const branch of [...branches].sort()) {
    specs.push(makeSpec('C_correctness', branch));
  }

  if (codexEnabled) {
    specs.push(makeSpec('C_codex', null));
  }

  return specs;
}
