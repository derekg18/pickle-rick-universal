const DEFAULT_SOLVER_COUNT = 3;
const MAX_SOLVER_COUNT = 8;
const DEFAULT_STRATEGIES = ['baseline', 'risk-first', 'minimal-change', 'test-first'];
const WORKFLOW_COMMANDS = [
    'vindicators',
    'two-brothers',
    'story-train',
    'wubba-lubba-dub-dub',
    'meeseeks',
    'meeseeks-zellij',
];
function normalizedProblem(problem) {
    const value = problem?.trim();
    return value && value.length > 0 ? value : 'No problem statement provided.';
}
function boundedSolverCount(value) {
    if (value === undefined)
        return DEFAULT_SOLVER_COUNT;
    if (!Number.isInteger(value) || value < 1 || value > MAX_SOLVER_COUNT) {
        throw new Error(`solverCount must be an integer from 1 to ${MAX_SOLVER_COUNT}.`);
    }
    return value;
}
function buildSolverPlans(input) {
    const problem = normalizedProblem(input.problem);
    const count = boundedSolverCount(input.solverCount ?? input.solverFixtures?.length);
    return Array.from({ length: count }, (_, index) => {
        const fixture = input.solverFixtures?.[index];
        const id = fixture?.id ?? `solver-${index + 1}`;
        const strategy = fixture?.strategy ?? input.strategies?.[index] ?? DEFAULT_STRATEGIES[index % DEFAULT_STRATEGIES.length];
        return {
            id,
            strategy,
            summary: fixture?.summary ?? `${strategy} plan for ${problem}`,
        };
    });
}
function defaultScores(solverPlans) {
    return solverPlans.map((plan, index) => ({
        solver_id: plan.id,
        score: solverPlans.length - index,
        rationale: `${plan.strategy} ranked by fixture order.`,
    }));
}
function judgePlans(solverPlans, scores) {
    if (solverPlans.length === 0) {
        return { status: 'needs_followup', scores: [], tied_solver_ids: [], code: 'JUDGE_TIE' };
    }
    const validSolverIds = new Set(solverPlans.map((plan) => plan.id));
    const normalizedScores = scores.filter((score) => validSolverIds.has(score.solver_id));
    const effectiveScores = normalizedScores.length > 0 ? normalizedScores : defaultScores(solverPlans);
    const topScore = Math.max(...effectiveScores.map((score) => score.score));
    const tiedSolverIds = effectiveScores
        .filter((score) => score.score === topScore)
        .map((score) => score.solver_id);
    if (tiedSolverIds.length !== 1) {
        return {
            status: 'needs_followup',
            scores: [...effectiveScores],
            tied_solver_ids: tiedSolverIds,
            code: 'JUDGE_TIE',
        };
    }
    const winnerId = tiedSolverIds[0];
    const winner = solverPlans.find((plan) => plan.id === winnerId);
    return {
        status: 'selected',
        winner_id: winnerId,
        selected_solution_summary: winner?.summary ?? `Selected ${winnerId}.`,
        scores: [...effectiveScores],
    };
}
export function runVindicatorWorkflow(input) {
    const solverPlans = buildSolverPlans(input);
    const judgeResult = judgePlans(solverPlans, input.judgeFixture ?? defaultScores(solverPlans));
    const problem = normalizedProblem(input.problem);
    if (judgeResult.status === 'needs_followup') {
        return {
            command: 'vindicators',
            status: 'needs_followup',
            summary: `Judge tie requires follow-up for ${judgeResult.tied_solver_ids?.join(', ') || 'solvers'}.`,
            problem,
            solver_plans: solverPlans,
            judge_result: judgeResult,
        };
    }
    return {
        command: 'vindicators',
        status: 'success',
        summary: `Judge selected ${judgeResult.winner_id}.`,
        problem,
        solver_plans: solverPlans,
        judge_result: judgeResult,
    };
}
function runProbe(command, input) {
    const solverCount = boundedSolverCount(input.solverCount);
    const problem = normalizedProblem(input.problem);
    const strategyCount = input.strategies?.length ?? Math.min(solverCount, DEFAULT_STRATEGIES.length);
    return {
        command,
        status: 'success',
        summary: `Workflow probe for /${command} is ready.`,
        problem,
        workflow: {
            kind: 'workflow-probe',
            stages: ['collect-problem', 'plan-solvers', 'judge-or-report'],
            analytics: {
                solver_count: solverCount,
                strategy_count: strategyCount,
                delivery_probe: command === 'wubba-lubba-dub-dub' ? 'delivery-analytics' : 'workflow-routing',
            },
        },
    };
}
export function runDeprecatedMeeseeksRouting(command, problem) {
    return {
        command,
        status: 'success',
        summary: `/${command} is deprecated; route this request to /vindicators.`,
        problem: normalizedProblem(problem),
        deprecation: {
            deprecated: true,
            replacement: '/vindicators',
            routed_command: 'vindicators',
        },
    };
}
export function runWorkflowCommand(command, input) {
    switch (command) {
        case 'vindicators':
            return runVindicatorWorkflow(input);
        case 'two-brothers':
        case 'story-train':
        case 'wubba-lubba-dub-dub':
            return runProbe(command, input);
        case 'meeseeks':
        case 'meeseeks-zellij':
            return runDeprecatedMeeseeksRouting(command, input.problem);
    }
}
export function isWorkflowCommand(value) {
    return WORKFLOW_COMMANDS.includes(value);
}
