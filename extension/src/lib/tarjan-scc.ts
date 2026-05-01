import type { Graph, CycleRow } from '../types/plumbus-frame-analyzer.js';

function nodeId(node: Record<string, unknown>): string | null {
  return typeof node['id'] === 'string' ? node['id'] : null;
}

function buildAdjacency(graph: Graph): Map<string, string[]> {
  const adj = new Map<string, string[]>();

  for (const node of graph.nodes) {
    const id = nodeId(node);
    if (id !== null && !adj.has(id)) adj.set(id, []);
  }

  for (const edge of graph.edges) {
    const src =
      (typeof edge['source'] === 'string' ? edge['source'] : null) ??
      (typeof edge['from'] === 'string' ? edge['from'] : null);
    const tgt =
      (typeof edge['target'] === 'string' ? edge['target'] : null) ??
      (typeof edge['to'] === 'string' ? edge['to'] : null);
    if (!src || !tgt) continue;
    if (!adj.has(src)) adj.set(src, []);
    adj.get(src)!.push(tgt);
  }

  for (const [, neighbors] of adj) neighbors.sort();

  return adj;
}

function tarjanSCC(adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const sccStack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  interface WorkItem {
    node: string;
    neighborIdx: number;
  }

  for (const startNode of [...adj.keys()].sort()) {
    if (index.has(startNode)) continue;

    const workStack: WorkItem[] = [{ node: startNode, neighborIdx: 0 }];

    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1];
      const { node } = frame;

      if (frame.neighborIdx === 0) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        onStack.add(node);
        sccStack.push(node);
      }

      const neighbors = adj.get(node) ?? [];

      if (frame.neighborIdx < neighbors.length) {
        const neighbor = neighbors[frame.neighborIdx];
        frame.neighborIdx++;

        if (!index.has(neighbor)) {
          workStack.push({ node: neighbor, neighborIdx: 0 });
        } else if (onStack.has(neighbor)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, index.get(neighbor)!));
        }
      } else {
        workStack.pop();

        if (workStack.length > 0) {
          const parent = workStack[workStack.length - 1].node;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
        }

        if (lowlink.get(node) === index.get(node)) {
          const scc: string[] = [];
          let popped: string;
          do {
            popped = sccStack.pop()!;
            onStack.delete(popped);
            scc.push(popped);
          } while (popped !== node);
          sccs.push(scc);
        }
      }
    }
  }

  return sccs;
}

// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
function detectConvergenceSignal(
  sccNodes: string[],
  nodeMap: Map<string, Record<string, unknown>>,
): CycleRow['convergence_signal'] {
  for (const id of sccNodes) {
    const node = nodeMap.get(id);
    if (!node) continue;

    const cls = node['class'];
    const epsilon = node['convergence_epsilon'];
    const until = node['until'];
    if (
      cls === 'iterate' &&
      typeof epsilon !== 'undefined' && epsilon !== null && Number(epsilon) > 0 &&
      until !== undefined && until !== null && until !== ''
    ) {
      return 'iterate';
    }
  }

  for (const id of sccNodes) {
    const node = nodeMap.get(id);
    if (!node) continue;
    if (node['model_ladder'] !== undefined && node['model_ladder'] !== null && node['ladder_advance_on'] === 'rollback') {
      return 'model_ladder';
    }
  }

  for (const id of sccNodes) {
    const node = nodeMap.get(id);
    if (!node) continue;
    const ctxKeys = node['context_keys'];
    if (typeof ctxKeys === 'string') {
      const keys = ctxKeys.split(',').map(k => k.trim());
      if (
        keys.includes('__pool_findings__') ||
        keys.includes('__fix_attempt_history') ||
        keys.includes('__last_failure_output')
      ) {
        return 'fix_attempt_history';
      }
    }
  }

  return null;
}

// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function buildCycles(graph: Graph): CycleRow[] {
  const adj = buildAdjacency(graph);
  const rawSccs = tarjanSCC(adj);

  const nodeMap = new Map<string, Record<string, unknown>>();
  for (const node of graph.nodes) {
    const id = nodeId(node);
    if (id !== null) nodeMap.set(id, node);
  }

  const selfLoopNodes = new Set<string>();
  for (const edge of graph.edges) {
    const src =
      (typeof edge['source'] === 'string' ? edge['source'] : null) ??
      (typeof edge['from'] === 'string' ? edge['from'] : null);
    const tgt =
      (typeof edge['target'] === 'string' ? edge['target'] : null) ??
      (typeof edge['to'] === 'string' ? edge['to'] : null);
    if (src && tgt && src === tgt) selfLoopNodes.add(src);
  }

  const rows: CycleRow[] = [];

  for (const scc of rawSccs) {
    const isTrivial = scc.length === 1 && !selfLoopNodes.has(scc[0]);
    if (isTrivial) continue;

    const sccNodes = [...scc].sort();
    const convergenceSignal = detectConvergenceSignal(sccNodes, nodeMap);
    rows.push({ scc_nodes: sccNodes, convergence_signal: convergenceSignal });
  }

  return rows;
}
