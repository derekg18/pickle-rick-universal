import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    parseTicketFrontmatter,
    buildHandoffSummary,
} from '../services/pickle-utils.js';
import {
    applyTicketTierBudgetSnapshot,
    resolveCurrentTicketTierBudget,
} from '../bin/mux-runner.js';

function withTempFile(content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-tier-'));
    const file = path.join(dir, 'linear_ticket_test.md');
    fs.writeFileSync(file, content);
    try {
        fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

function withTempSession(ticketContent, settings, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-tier-session-'));
    const ticketDir = path.join(dir, 'T1');
    const extensionRoot = path.join(dir, 'runtime');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.mkdirSync(extensionRoot, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'linear_ticket_T1.md'), ticketContent);
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify(settings, null, 2));
    try {
        fn({ sessionDir: dir, extensionRoot });
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

// --- parseTicketFrontmatter: complexity_tier ---

test('complexity_tier: parses valid tier "small"', () => {
    withTempFile('---\nid: t1\ntitle: Test\nstatus: Todo\norder: 1\ncomplexity_tier: small\n---\n', (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'small');
    });
});

test('complexity_tier: invalid value defaults to medium', () => {
    withTempFile('---\nid: t2\ntitle: Test\nstatus: Todo\norder: 1\ncomplexity_tier: huge\n---\n', (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'medium');
    });
});

test('complexity_tier: missing field defaults to medium', () => {
    withTempFile('---\nid: t3\ntitle: Test\nstatus: Todo\norder: 1\n---\n', (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'medium');
    });
});

test('complexity_tier: all 4 valid values accepted', () => {
    for (const tier of ['trivial', 'small', 'medium', 'large']) {
        withTempFile(`---\nid: t4\ntitle: Test\nstatus: Todo\norder: 1\ncomplexity_tier: ${tier}\n---\n`, (file) => {
            const result = parseTicketFrontmatter(file);
            assert.equal(result.complexity_tier, tier, `expected tier '${tier}' to be accepted`);
        });
    }
});

// --- buildHandoffSummary: complexity_tier display ---

test('complexity_tier: handoff shows tag for non-medium tiers, omits for medium', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-tier-'));
    try {
        // Create tickets with different tiers
        for (const [id, tier] of [['triv', 'trivial'], ['sm', 'small'], ['med', 'medium'], ['lg', 'large']]) {
            const ticketDir = path.join(dir, id);
            fs.mkdirSync(ticketDir);
            fs.writeFileSync(
                path.join(ticketDir, `linear_ticket_${id}.md`),
                `---\nid: ${id}\ntitle: Ticket ${tier}\nstatus: Todo\norder: 1\ncomplexity_tier: ${tier}\n---\n`
            );
        }

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);

        assert.match(summary, /triv:.*\[trivial\]/, 'trivial tier should show [trivial] tag');
        assert.match(summary, /sm:.*\[small\]/, 'small tier should show [small] tag');
        assert.ok(!summary.match(/med:.*\[medium\]/), 'medium tier should NOT show [medium] tag');
        assert.match(summary, /lg:.*\[large\]/, 'large tier should show [large] tag');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- mux-runner: tier budget mapping ---

test('complexity_tier: tier budget mapping covers trivial, small, medium, and large', () => {
    const tierBudgets = { trivial: 11, small: 22, medium: 33, large: 44 };
    for (const [tier, budget] of Object.entries(tierBudgets)) {
        withTempSession(
            `---\nid: T1\ntitle: Ticket ${tier}\nstatus: Todo\norder: 1\ncomplexity_tier: ${tier}\n---\n`,
            { tier_budgets: tierBudgets },
            ({ sessionDir, extensionRoot }) => {
                const state = {
                    current_ticket: 'T1',
                    max_iterations: 999,
                };
                const resolved = resolveCurrentTicketTierBudget(state, sessionDir, extensionRoot);
                assert.deepEqual(resolved, { tier, budget });

                const next = applyTicketTierBudgetSnapshot(state, resolved);
                assert.equal(next.current_ticket_tier, tier);
                assert.equal(next.current_ticket_budget, budget);
                assert.equal(next.max_iterations, budget);
            }
        );
    }
});

test('complexity_tier: missing field preserves existing max_iterations behavior', () => {
    withTempSession(
        '---\nid: T1\ntitle: Untiered ticket\nstatus: Todo\norder: 1\n---\n',
        { tier_budgets: { trivial: 11, small: 22, medium: 33, large: 44 } },
        ({ sessionDir, extensionRoot }) => {
            const state = {
                current_ticket: 'T1',
                current_ticket_tier: 'large',
                current_ticket_budget: 44,
                max_iterations: 77,
            };
            const resolved = resolveCurrentTicketTierBudget(state, sessionDir, extensionRoot);
            assert.equal(resolved, null);

            const next = applyTicketTierBudgetSnapshot(state, resolved);
            assert.equal(next.max_iterations, 77);
            assert.equal(next.current_ticket_tier, undefined);
            assert.equal(next.current_ticket_budget, undefined);
        }
    );
});
