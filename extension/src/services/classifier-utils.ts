// Codex plain-text block delimiters. A line matching this regex marks the
// start of a new named block; content between a 'codex' delimiter and the
// next delimiter (or EOF) is assistant output. All other blocks are dropped.
const CODEX_DELIMITER_RE = /^(user|codex|exec|tokens used|reasoning|tool_call)\s*$/;

/**
 * Extracts text content from assistant messages.
 *
 * Detection precedence:
 * 1. Stream-json: >=1 line parses as JSON with type:'assistant'. Extracts
 *    only assistant text blocks and result blocks. Non-JSON lines and all
 *    other JSON types (user, system, tool_use) are skipped.
 * 2. Codex plain-text: >=1 line matches CODEX_DELIMITER_RE. Extracts content
 *    between 'codex' delimiters only; user/exec/tokens/reasoning/tool_call
 *    blocks are dropped. Multi-turn: union of all surviving codex blocks.
 * 3. Pure plain-text fallback: returns output as-is.
 *
 * Promise tokens embedded in reviewed source (tool_result, user prompts,
 * codex user blocks) are excluded in all modes.
 */
// eslint-disable-next-line complexity -- pre-existing parser moved from mux-runner
export function extractAssistantContent(output: string): string {
  const lines = output.split('\n');

  // Mode 1: stream-json - requires >=1 JSON line that is a typed object
  // ({type:...}). Bare JSON values (null, numbers, arrays, objects without
  // a 'type' key) do NOT trigger this mode, so codex logs with a stray null
  // line fall through to codex-mode detection instead of silently eating all
  // content as stream-json with zero extractions.
  let isStreamJson = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'type' in parsed) {
        isStreamJson = true;
        break;
      }
    } catch { /* not JSON */ }
  }

  if (isStreamJson) {
    const parts: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'assistant') {
          const content = parsed.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                parts.push(block.text);
              }
            }
          } else if (typeof content === 'string') {
            parts.push(content);
          }
        } else if (parsed.type === 'result' && typeof parsed.result === 'string') {
          parts.push(parsed.result);
        }
        // Intentionally skip: user (tool_result), system, tool_use
      } catch { /* skip non-JSON in stream-json mode */ }
    }
    return parts.join('\n');
  }

  // Mode 2: codex plain-text - block-delimiter format.
  let isCodexMode = false;
  for (const line of lines) {
    if (CODEX_DELIMITER_RE.test(line)) { isCodexMode = true; break; }
  }

  if (isCodexMode) {
    const parts: string[] = [];
    let inCodexBlock = false;
    for (const line of lines) {
      if (CODEX_DELIMITER_RE.test(line)) {
        inCodexBlock = /^codex\s*$/.test(line);
        continue;
      }
      if (inCodexBlock) parts.push(line);
    }
    return parts.join('\n');
  }

  // Mode 3: pure plain-text fallback - return everything.
  return output;
}
