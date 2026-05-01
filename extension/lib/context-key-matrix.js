import { isEngineWritten } from './engine-keys-registry.js';
const CONDITION_RE = /context\.(\w+)/;
const TOOL_CMD_WRITE_RE = /ATTRACTOR_CTX:\s*(\w+)\s*=/g;
const ATTRACTOR_CTX_READ_RE = /\$\{ATTRACTOR_CTX_(\w+)\}/g;
function parseKeys(raw) {
    return raw
        .split(',')
        .map(kv => kv.trim().split('=')[0].trim())
        .filter(Boolean);
}
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function buildContextKeyMatrix(graph, registry) {
    const writers = new Map();
    const readers = new Map();
    function addWriter(key, nodeId) {
        if (!writers.has(key))
            writers.set(key, new Set());
        writers.get(key).add(nodeId);
    }
    function addReader(key, nodeId) {
        if (!readers.has(key))
            readers.set(key, new Set());
        readers.get(key).add(nodeId);
    }
    for (const node of graph.nodes) {
        const id = typeof node['id'] === 'string' ? node['id'] : null;
        if (!id)
            continue;
        for (const attr of ['context_on_success', 'context_on_failure']) {
            const raw = node[attr];
            if (typeof raw === 'string') {
                for (const key of parseKeys(raw))
                    addWriter(key, id);
            }
        }
        const ctxKeys = node['context_keys'];
        if (typeof ctxKeys === 'string') {
            for (const key of ctxKeys.split(',').map(k => k.trim()).filter(Boolean)) {
                addReader(key, id);
            }
        }
        for (const field of ['tool_command', 'prompt']) {
            const val = node[field];
            if (typeof val !== 'string')
                continue;
            for (const m of val.matchAll(TOOL_CMD_WRITE_RE))
                addWriter(m[1], id);
            for (const m of val.matchAll(ATTRACTOR_CTX_READ_RE))
                addReader(m[1], id);
        }
    }
    for (const edge of graph.edges) {
        const attrsObj = typeof edge['attrs'] === 'object' && edge['attrs'] !== null
            ? edge['attrs']
            : null;
        const condition = (attrsObj?.['condition'] ?? edge['condition']);
        if (typeof condition !== 'string')
            continue;
        const match = CONDITION_RE.exec(condition);
        if (!match)
            continue;
        const key = match[1];
        const targetId = (typeof edge['target'] === 'string' ? edge['target'] : null) ??
            (typeof edge['to'] === 'string' ? edge['to'] : null);
        if (!targetId)
            continue;
        addReader(key, targetId);
    }
    const allKeys = new Set([...writers.keys(), ...readers.keys()]);
    const rows = [];
    for (const key of allKeys) {
        if (isEngineWritten(key, registry))
            continue;
        rows.push({
            key,
            writers: [...(writers.get(key) ?? new Set())].sort(),
            readers: [...(readers.get(key) ?? new Set())].sort(),
        });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
}
