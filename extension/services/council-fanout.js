const UNCONDITIONAL_B_CATEGORIES = [
    'B1_stack_structure',
    'B2_claude_md',
    'B3_contract_discovery',
    'B4_cross_branch',
    'B5_test_coverage',
    'B6_security',
    'B8_szechuan',
    'B9_polish',
];
const SHARDED_TIERS = new Set(['l', 'xl', 'xxl']);
export function planFanOut(input) {
    const { stackTier, branches, codexEnabled, hasMigrationJournal } = input;
    const sharded = SHARDED_TIERS.has(stackTier);
    const specs = [];
    function makeSpec(category, branch) {
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
    }
    else {
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
