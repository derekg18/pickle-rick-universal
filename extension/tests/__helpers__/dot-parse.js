// Shared DOT parser for DotBuilder tests.
// ESM, zero external runtime deps. Consumed by the *.test.js files that
// assert on structural properties of emitted DOT (v8 convergence topology,
// snapshot fixtures, pattern coverage).
//
// parseDot(dot) returns:
//   {
//     nodes:      Map<id, Record<attrKey, attrValue>>,
//     edges:      Array<{ from, to, attrs: Record<attrKey, attrValue> }>,
//     graphAttrs: Record<attrKey, attrValue>,
//   }
//
// The parser is line-oriented and tolerant of any leading whitespace so it
// works for both top-level graph children (2-space indent) and subgraph
// cluster body nodes (4-space indent). It respects backslash-escaped double
// quotes inside attribute values.

/**
 * Parse a DOT attribute-list body (the text between `[` and `]`) into a
 * plain object. One `key=value` pair at a time. Values may be quoted
 * ("..."), in which case backslash-escaped double quotes are honored, or
 * bare words (terminated by whitespace, comma, or close-bracket).
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseAttrs(body) {
  const attrs = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && (body[i] === ' ' || body[i] === '\t' || body[i] === ',')) i++;
    if (i >= body.length) break;
    const keyMatch = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*=\s*/.exec(body.slice(i));
    if (!keyMatch) break;
    i += keyMatch[0].length;
    const key = keyMatch[1];
    if (body[i] === '"') {
      i++;
      let value = '';
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\' && i + 1 < body.length) {
          const next = body[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
        } else {
          value += body[i++];
        }
      }
      if (body[i] === '"') i++;
      attrs[key] = value;
    } else {
      const bw = /^[^\s,\]]+/.exec(body.slice(i));
      if (!bw) break;
      attrs[key] = bw[0];
      i += bw[0].length;
    }
  }
  return attrs;
}

/**
 * Parse a DOT source string into a structural view.
 *
 * @param {string} dot
 * @returns {{ nodes: Map<string, Record<string, string>>, edges: Array<{ from: string, to: string, attrs: Record<string, string> }>, graphAttrs: Record<string, string> }}
 */
export function parseDot(dot) {
  const nodes = new Map();
  const edges = [];
  let graphAttrs = {};

  const lines = dot.split('\n');

  // Graph-level attrs live on a single `  graph [...]` line emitted by
  // DotBuilder. Scan for it first so the subsequent node/edge loop can
  // ignore it.
  for (const line of lines) {
    const gm = /^\s*graph\s*\[(.*)\]\s*$/.exec(line);
    if (gm) {
      graphAttrs = parseAttrs(gm[1]);
      break;
    }
  }

  const edgeRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\[(.*)\])?\s*$/;
  const nodeRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\[(.*)\]\s*$/;

  for (const line of lines) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    if (/^\s*(digraph|subgraph|graph|\}|\{)/.test(line)) continue;
    const em = edgeRe.exec(line);
    if (em) {
      edges.push({ from: em[1], to: em[2], attrs: parseAttrs(em[3] ?? '') });
      continue;
    }
    const nm = nodeRe.exec(line);
    if (nm) {
      nodes.set(nm[1], parseAttrs(nm[2]));
    }
  }

  return { nodes, edges, graphAttrs };
}
