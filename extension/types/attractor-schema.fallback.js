export const ATTRACTOR_SCHEMA_FALLBACK = {
    /* 36 node attributes — builder-emitted only */
    node: {
        class: { name: "class", type: "string", scope: "node" },
        shape: { name: "shape", type: "string", scope: "node" },
        label: { name: "label", type: "string", scope: "node" },
        goal_gate: { name: "goal_gate", type: "boolean", scope: "node" },
        retry_target: { name: "retry_target", type: "string", scope: "node" },
        max_visits: { name: "max_visits", type: "number", scope: "node" },
        thread_id: { name: "thread_id", type: "string", scope: "node" },
        timeout: { name: "timeout", type: "string", scope: "node" },
        allowed_paths: { name: "allowed_paths", type: "string[]", scope: "node" },
        read_only: { name: "read_only", type: "boolean", scope: "node" },
        context_on_success: { name: "context_on_success", type: "string", scope: "node" },
        prompt: { name: "prompt", type: "string", scope: "node" },
        tool_command: { name: "tool_command", type: "string", scope: "node" },
        max_parallel: { name: "max_parallel", type: "number", scope: "node" },
        escalate_on: { name: "escalate_on", type: "string", scope: "node" },
        permission_mode: { name: "permission_mode", type: "string", scope: "node" },
        auto_status: { name: "auto_status", type: "boolean", scope: "node" },
        allow_partial: { name: "allow_partial", type: "boolean", scope: "node" },
        coverage_target: { name: "coverage_target", type: "number", scope: "node" },
        repo_url: { name: "repo_url", type: "string", scope: "node" },
        cleanup: { name: "cleanup", type: "string", scope: "node" },
        direction: { name: "direction", type: "string", scope: "node" },
        target: { name: "target", type: "number", scope: "node" },
        ratchet_count: { name: "ratchet_count", type: "number", scope: "node" },
        body: { name: "body", type: "string", scope: "node" },
        until: { name: "until", type: "string", scope: "node" },
        model: { name: "model", type: "string", scope: "node" },
        reviewer_lens: { name: "reviewer_lens", type: "string", scope: "node" },
        sealed_from_source: { name: "sealed_from_source", type: "string", scope: "node" },
        harness: { name: "harness", type: "string", scope: "node" },
        max_iterations: { name: "max_iterations", type: "number", scope: "node" },
        /* v8 iterate-body convergence gate metric — string, dotted (e.g. "mechanical.boot"). Routes the
         * gate's outcome into the iterate handler's V_total accumulator. Tool nodes carrying this attr
         * are convergence gates and are subject to validator rule `gate_self_retry_loop` (cannot self-retry). */
        reports_to_v: { name: "reports_to_v", type: "string", scope: "node" },
        /* Opt-in for `god_node_retry_target` rule. Set on a codergen fix node when multiple gates
         * legitimately route to it within ONE code domain (e.g. backend build + tests + lint all
         * targeting one fix_backend). The rule's 3-referrer ERROR is suppressed for the target. Use
         * sparingly — for cross-domain god nodes, split the fixer instead. */
        allow_multi_retry_target: { name: "allow_multi_retry_target", type: "boolean", scope: "node" },
        /* v8 convergence topology attrs */
        convergence_epsilon: { name: "convergence_epsilon", type: "number", scope: "node" },
        context_on_failure: { name: "context_on_failure", type: "string", scope: "node" },
        context_keys: { name: "context_keys", type: "string", scope: "node" },
    },
    graph: {
        label: { name: "label", type: "string", scope: "graph" },
        rankdir: { name: "rankdir", type: "string", scope: "graph" },
        goal: { name: "goal", type: "string", scope: "graph" },
        working_dir: { name: "working_dir", type: "string", scope: "graph" },
        default_max_retry: {
            name: "default_max_retry",
            type: "number",
            scope: "graph",
        },
        acceptance_criteria: {
            name: "acceptance_criteria",
            type: "string[]",
            scope: "graph",
        },
        model_stylesheet: {
            name: "model_stylesheet",
            type: "string",
            scope: "graph",
        },
        spec_file: { name: "spec_file", type: "string", scope: "graph" },
        workspace: { name: "workspace", type: "string", scope: "graph" },
        repo_url: { name: "repo_url", type: "string", scope: "graph" },
        repo_branch: { name: "repo_branch", type: "string", scope: "graph" },
        workspace_cleanup: {
            name: "workspace_cleanup",
            type: "boolean",
            scope: "graph",
        },
        retry_target: { name: "retry_target", type: "string", scope: "graph" },
    },
    edge: {
        condition: { name: "condition", type: "string", scope: "edge" },
        outcome: { name: "outcome", type: "string", scope: "edge" },
        loop_restart: { name: "loop_restart", type: "boolean", scope: "edge" },
        weight: { name: "weight", type: "number", scope: "edge" },
        label: { name: "label", type: "string", scope: "edge" },
    },
};
/** Flat list of all 54 attribute definitions across all scopes (36 node + 13 graph + 5 edge). */
export const ALL_ATTRS = [
    ...Object.values(ATTRACTOR_SCHEMA_FALLBACK.node),
    ...Object.values(ATTRACTOR_SCHEMA_FALLBACK.graph),
    ...Object.values(ATTRACTOR_SCHEMA_FALLBACK.edge),
];
/** Lookup by scope then attribute key. retry_target exists in both node+graph. */
export function lookupAttr(name, scope) {
    const bucket = ATTRACTOR_SCHEMA_FALLBACK[scope];
    return bucket[name];
}
/** Runtime type check: returns true if value matches the AttrDef type. */
export function validateAttrType(def, value) {
    if (def.type === "string[]") {
        return Array.isArray(value) && value.every((v) => typeof v === "string");
    }
    if (def.type === "number[]") {
        return Array.isArray(value) && value.every((v) => typeof v === "number");
    }
    return typeof value === def.type;
}
export function validateAttrs(scope, attrs) {
    const schema = ATTRACTOR_SCHEMA_FALLBACK[scope];
    const allKeys = new Set(Object.keys(schema));
    const diagnostics = [];
    for (const [key, rawValue] of Object.entries(attrs)) {
        if (!allKeys.has(key)) {
            diagnostics.push({
                attribute: key,
                message: `unknown ${scope} attribute "${key}" — not in fallback schema`,
            });
            continue;
        }
        const def = schema[key];
        // DOT emission serialises everything to string, but numeric/boolean
        // should at least parse cleanly.
        if (def.type === "number") {
            if (Number.isNaN(Number(rawValue))) {
                diagnostics.push({
                    attribute: key,
                    message: `"${key}" should be numeric (got "${rawValue}")`,
                });
            }
        }
        else if (def.type === "boolean") {
            if (rawValue !== "true" && rawValue !== "false") {
                diagnostics.push({
                    attribute: key,
                    message: `"${key}" should be boolean "true" or "false" (got "${rawValue}")`,
                });
            }
        }
        else if (def.type === "string[]") {
            // comma-separated in DOT; must have at least one non-empty token
            if (rawValue.includes(",")) {
                const tokens = rawValue.split(",").map((t) => t.trim()).filter(Boolean);
                if (tokens.length === 0) {
                    diagnostics.push({
                        attribute: key,
                        message: `"${key}" is a string[] but contains no tokens`,
                    });
                }
            }
        }
    }
    return { ok: diagnostics.length === 0, diagnostics };
}
