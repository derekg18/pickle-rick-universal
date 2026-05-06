const CONDITION_RE = /^context\.(\w+)=(.+)$/;
const CARTESIAN_CAP = 256;
function edgeCondition(edge) {
    const attrs = typeof edge['attrs'] === 'object' && edge['attrs'] !== null
        ? edge['attrs']
        : null;
    const raw = attrs?.['condition'] ?? edge['condition'];
    return typeof raw === 'string' ? raw : null;
}
function parseCondition(condition) {
    const m = CONDITION_RE.exec(condition.trim());
    return m ? { key: m[1], expectedValue: m[2] } : null;
}
function edgeId(edge) {
    if (typeof edge['id'] === 'string')
        return edge['id'];
    const src = (typeof edge['source'] === 'string' ? edge['source'] : null) ??
        (typeof edge['from'] === 'string' ? edge['from'] : null) ??
        '?';
    const tgt = (typeof edge['target'] === 'string' ? edge['target'] : null) ??
        (typeof edge['to'] === 'string' ? edge['to'] : null) ??
        '?';
    return `${src}->${tgt}`;
}
function nodeClass(node) {
    if (typeof node['class'] === 'string')
        return node['class'];
    const attrs = typeof node['attrs'] === 'object' && node['attrs'] !== null
        ? node['attrs']
        : null;
    return typeof attrs?.['class'] === 'string' ? attrs['class'] : null;
}
function cartesian(keySets) {
    if (keySets.length === 0)
        return [{}];
    const [[key, values], ...rest] = keySets;
    const subs = cartesian(rest);
    const result = [];
    for (const val of values) {
        for (const sub of subs) {
            result.push({ [key]: val, ...sub });
        }
    }
    return result;
}
function collectObservedValues(graph) {
    const observed = new Map();
    function add(key, val) {
        if (!observed.has(key))
            observed.set(key, new Set());
        observed.get(key).add(val);
    }
    for (const node of graph.nodes) {
        for (const attr of ['context_on_success', 'context_on_failure']) {
            const raw = node[attr];
            if (typeof raw !== 'string')
                continue;
            for (const kv of raw.split(',')) {
                const eq = kv.indexOf('=');
                if (eq < 0)
                    continue;
                const k = kv.slice(0, eq).trim();
                const v = kv.slice(eq + 1).trim();
                if (k && v)
                    add(k, v);
            }
        }
    }
    return observed;
}
function collectOutgoingConditionEdges(graph) {
    const outgoing = new Map();
    for (const edge of graph.edges) {
        const src = (typeof edge['source'] === 'string' ? edge['source'] : null) ??
            (typeof edge['from'] === 'string' ? edge['from'] : null);
        if (!src)
            continue;
        const condStr = edgeCondition(edge);
        if (!condStr)
            continue;
        const parsed = parseCondition(condStr);
        if (!parsed)
            continue;
        if (!outgoing.has(src))
            outgoing.set(src, []);
        outgoing.get(src).push({ id: edgeId(edge), condition: parsed });
    }
    return outgoing;
}
function collectDiamondIds(graph, outgoing) {
    const diamonds = new Set();
    for (const node of graph.nodes) {
        const id = typeof node['id'] === 'string' ? node['id'] : null;
        if (!id)
            continue;
        if (nodeClass(node) === 'diamond') {
            diamonds.add(id);
        }
        else if ((outgoing.get(id)?.length ?? 0) >= 2) {
            diamonds.add(id);
        }
    }
    return diamonds;
}
function buildKeySets(edges, observed) {
    const referencedKeys = [...new Set(edges.map(e => e.condition.key))].sort();
    return referencedKeys.map(key => {
        if (key === 'outcome')
            return [key, ['fail', 'success', 'unset']];
        const obs = observed.get(key) ?? new Set();
        return [key, [...new Set([...obs, 'unset'])].sort()];
    });
}
function routeDiamond(edges, observed) {
    const keySets = buildKeySets(edges, observed);
    const totalCells = keySets.reduce((acc, [, vals]) => acc * vals.length, 1);
    if (totalCells > CARTESIAN_CAP) {
        return {
            covered_states: [],
            stuck_states: [
                { cell: {}, matchingEdges: [], note: 'diamond too complex to enumerate mechanically' },
            ],
        };
    }
    const covered = [];
    const stuck = [];
    for (const cell of cartesian(keySets)) {
        const matching = edges
            .filter(e => cell[e.condition.key] === e.condition.expectedValue)
            .map(e => e.id)
            .sort();
        if (matching.length === 0) {
            stuck.push({ cell, matchingEdges: [] });
        }
        else {
            covered.push({ cell, matchingEdges: matching });
        }
    }
    return { covered_states: covered, stuck_states: stuck };
}
export function buildDiamondRouting(graph) {
    const outgoing = collectOutgoingConditionEdges(graph);
    const observed = collectObservedValues(graph);
    const diamonds = collectDiamondIds(graph, outgoing);
    const rows = [];
    for (const diamond of [...diamonds].sort()) {
        const edges = outgoing.get(diamond);
        if (!edges || edges.length === 0)
            continue;
        rows.push({ diamond, ...routeDiamond(edges, observed) });
    }
    return rows;
}
