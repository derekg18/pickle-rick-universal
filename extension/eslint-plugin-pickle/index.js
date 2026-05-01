/**
 * eslint-plugin-pickle — architectural lint rules for Pickle Rick.
 *
 * Rules:
 *   pickle/no-raw-state-write    — must use writeStateFile(), not raw fs.writeFileSync on state
 *   pickle/cli-guard-basename    — CLI guards must use path.basename(process.argv[1]) === '...'
 *   pickle/hook-decision-values  — hook decisions must be "approve" or "block", never "allow"
 *   pickle/no-unsafe-error-cast  — catch bindings require instanceof Error guard before .message/.stack/.code
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if a node is `fs.writeFileSync` */
function isFsWriteFileSync(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'fs' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'writeFileSync'
  );
}

/** Check if a node resolves to a string containing "state.json" */
function refersToStateJson(node) {
  if (!node) return false;
  // Literal: "...state.json..."
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value.includes('state.json');
  }
  // Template literal
  if (node.type === 'TemplateLiteral') {
    return node.quasis.some((q) => q.value.raw.includes('state.json'));
  }
  // Variable named statePath, stateFile, etc.
  if (node.type === 'Identifier') {
    return /state/i.test(node.name) && /path|file/i.test(node.name);
  }
  // path.join(..., 'state.json') — any argument containing 'state.json'
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'path' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'join'
  ) {
    return node.arguments.some((arg) => refersToStateJson(arg));
  }
  return false;
}

/** Check if node is `process.argv[1]` */
function isProcessArgv1(node) {
  return (
    node.type === 'MemberExpression' &&
    node.computed === true &&
    node.object.type === 'MemberExpression' &&
    node.object.object.type === 'Identifier' &&
    node.object.object.name === 'process' &&
    node.object.property.type === 'Identifier' &&
    node.object.property.name === 'argv' &&
    node.property.type === 'Literal' &&
    node.property.value === 1
  );
}

/** Check if node is `path.basename(process.argv[1])` */
function isPathBasenameArgv1(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'path' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'basename' &&
    node.arguments.length >= 1 &&
    isProcessArgv1(node.arguments[0])
  );
}

/** Walk up to find enclosing CatchClause */
function getEnclosingCatch(node) {
  let current = node;
  while (current) {
    if (current.type === 'CatchClause') return current;
    current = current.parent;
  }
  return null;
}

/**
 * Check if an instanceof Error guard exists for `name` in the same scope,
 * before the given node. We look for `name instanceof Error` in the
 * condition of an enclosing IfStatement or ConditionalExpression.
 */
function hasInstanceofGuard(node, paramName) {
  let current = node.parent;
  while (current) {
    // Ternary: param instanceof Error ? param.message : ...
    if (current.type === 'ConditionalExpression' && current.consequent) {
      if (isInstanceofErrorCheck(current.test, paramName)) return true;
    }
    // If statement: if (param instanceof Error)
    if (current.type === 'IfStatement') {
      if (isInstanceofErrorCheck(current.test, paramName)) return true;
    }
    // Logical AND: param instanceof Error && param.message
    if (current.type === 'LogicalExpression' && current.operator === '&&') {
      if (isInstanceofErrorCheck(current.left, paramName)) return true;
    }
    current = current.parent;
  }
  return false;
}

function isInstanceofErrorCheck(test, paramName) {
  if (!test) return false;
  if (
    test.type === 'BinaryExpression' &&
    test.operator === 'instanceof' &&
    test.left.type === 'Identifier' &&
    test.left.name === paramName &&
    test.right.type === 'Identifier' &&
    test.right.name === 'Error'
  ) {
    return true;
  }
  // Handle negated or compound: !(x instanceof Error), x instanceof Error || ...
  if (test.type === 'LogicalExpression') {
    return (
      isInstanceofErrorCheck(test.left, paramName) ||
      isInstanceofErrorCheck(test.right, paramName)
    );
  }
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    return isInstanceofErrorCheck(test.argument, paramName);
  }
  return false;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

/** Check if a node is a call to `writeStateFile` (bare identifier) */
function isWriteStateFileCall(callee) {
  return callee.type === 'Identifier' && callee.name === 'writeStateFile';
}

/** Check if a node is sm.forceWrite() or *.forceWrite() */
function isForceWriteCall(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'forceWrite'
  );
}

const noRawStateWrite = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow raw state.json writes — use StateManager.update() / forceWrite()',
    },
    messages: {
      useWriteStateFile:
        'Use writeStateFile() instead of fs.writeFileSync for state.json. Raw writes risk corruption on crash.',
      useStateManager:
        'Use StateManager.update() or StateManager.forceWrite() instead of writeStateFile() for state.json. Direct writes bypass lock protection.',
      forceWriteNeedsComment:
        'StateManager.forceWrite() bypasses lock protection. Add eslint-disable comment explaining why lock cannot be acquired (e.g. signal handler crash path).',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Allow state-manager.ts (uses writeStateFile internally) and pickle-utils.ts (defines it)
    if (/state-manager\.[tj]s$/.test(filename)) return {};
    if (/pickle-utils\.[tj]s$/.test(filename)) return {};

    return {
      CallExpression(node) {
        // Flag fs.writeFileSync on state.json
        if (isFsWriteFileSync(node.callee)) {
          const firstArg = node.arguments[0];
          if (refersToStateJson(firstArg)) {
            context.report({ node, messageId: 'useWriteStateFile' });
          }
          return;
        }
        // Flag writeStateFile() on state.json
        if (isWriteStateFileCall(node.callee)) {
          const firstArg = node.arguments[0];
          if (refersToStateJson(firstArg)) {
            context.report({ node, messageId: 'useStateManager' });
          }
          return;
        }
        // Flag sm.forceWrite() on state.json — requires eslint-disable with justification
        if (isForceWriteCall(node.callee)) {
          const firstArg = node.arguments[0];
          if (refersToStateJson(firstArg)) {
            context.report({ node, messageId: 'forceWriteNeedsComment' });
          }
        }
      },
    };
  },
};

const cliGuardBasename = {
  meta: {
    type: 'problem',
    docs: {
      description: 'CLI entry guards must use path.basename(process.argv[1]) === "file.js"',
    },
    messages: {
      requireBasename:
        'Use `path.basename(process.argv[1]) === "file.js"` for CLI guards. Never use startsWith/endsWith/includes or bare equality on process.argv[1].',
    },
    schema: [],
  },
  create(context) {
    return {
      // Catch: process.argv[1].startsWith / endsWith / includes
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          isProcessArgv1(callee.object) &&
          callee.property.type === 'Identifier' &&
          ['startsWith', 'endsWith', 'includes'].includes(callee.property.name)
        ) {
          context.report({ node, messageId: 'requireBasename' });
        }
      },
      // Catch: process.argv[1] === "..." (without basename)
      BinaryExpression(node) {
        if (node.operator !== '===' && node.operator !== '==') return;
        const leftIsArgv1 = isProcessArgv1(node.left);
        const rightIsArgv1 = isProcessArgv1(node.right);
        if (!leftIsArgv1 && !rightIsArgv1) return;
        // OK if the other side is path.basename(process.argv[1])
        // But if raw process.argv[1] is directly compared to a literal, flag it
        const otherSide = leftIsArgv1 ? node.right : node.left;
        if (otherSide.type === 'Literal' && typeof otherSide.value === 'string') {
          context.report({ node, messageId: 'requireBasename' });
        }
      },
    };
  },
};

const hookDecisionValues = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Hook decisions must be "approve" or "block", never "allow"',
    },
    messages: {
      noAllow:
        'Hook decision "allow" is not recognized by Claude Code. Use "approve" or "block".',
      invalidDecision:
        'Hook decision must be "approve" or "block". Got "{{value}}".',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const inHooks = /hooks[/\\]/.test(filename);
    if (!inHooks) return {};

    return {
      // Flag decision property with wrong value
      Property(node) {
        if (
          node.key.type === 'Identifier' &&
          node.key.name === 'decision' &&
          node.value.type === 'Literal' &&
          typeof node.value.value === 'string'
        ) {
          if (node.value.value === 'allow') {
            context.report({ node: node.value, messageId: 'noAllow' });
          } else if (node.value.value !== 'approve' && node.value.value !== 'block') {
            context.report({
              node: node.value,
              messageId: 'invalidDecision',
              data: { value: node.value.value },
            });
          }
        }
      },
    };
  },
};

const noUnsafeErrorCast = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Catch bindings require instanceof Error guard before accessing .message/.stack/.code',
    },
    messages: {
      requireGuard:
        'Accessing .{{prop}} on catch binding "{{name}}" without `instanceof Error` guard. Use: `{{name}} instanceof Error ? {{name}}.{{prop}} : String({{name}})`',
      noAsCastError:
        'Do not cast catch binding to Error with `as Error`. Use instanceof guard instead.',
    },
    schema: [],
  },
  create(context) {
    const dangerousProps = new Set(['message', 'stack', 'code', 'cause']);

    return {
      // Flag: (err as Error) via TSAsExpression
      TSAsExpression(node) {
        if (
          node.typeAnnotation &&
          node.typeAnnotation.type === 'TSTypeReference' &&
          node.typeAnnotation.typeName &&
          node.typeAnnotation.typeName.name === 'Error' &&
          node.expression.type === 'Identifier'
        ) {
          const catchClause = getEnclosingCatch(node);
          if (catchClause && catchClause.param && catchClause.param.name === node.expression.name) {
            context.report({
              node,
              messageId: 'noAsCastError',
            });
          }
        }
      },
      // Flag: err.message without guard
      MemberExpression(node) {
        if (node.computed) return;
        if (node.property.type !== 'Identifier') return;
        if (!dangerousProps.has(node.property.name)) return;
        if (node.object.type !== 'Identifier') return;

        const catchClause = getEnclosingCatch(node);
        if (!catchClause) return;
        if (!catchClause.param) return; // catch without binding

        const paramName =
          catchClause.param.type === 'Identifier' ? catchClause.param.name : null;
        if (!paramName) return;
        if (node.object.name !== paramName) return;

        if (!hasInstanceofGuard(node, paramName)) {
          context.report({
            node,
            messageId: 'requireGuard',
            data: { prop: node.property.name, name: paramName },
          });
        }
      },
    };
  },
};

// ─── Rule: no-gemini-path ────────────────────────────────────────────────────

const noGeminiPath = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow ".gemini" in path strings — extension path is ~/.claude/pickle-rick',
    },
    messages: {
      noGemini:
        'Path contains ".gemini". The extension path is ~/.claude/pickle-rick, never .gemini.',
    },
    schema: [],
  },
  create(context) {
    function checkForGemini(node, value) {
      if (typeof value === 'string' && value.includes('.gemini')) {
        context.report({ node, messageId: 'noGemini' });
      }
    }
    return {
      Literal(node) {
        checkForGemini(node, node.value);
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          checkForGemini(node, quasi.value.raw);
        }
      },
    };
  },
};

// ─── Rule: no-deployed-file-edit ─────────────────────────────────────────────

const DEPLOYED_PATH_PATTERN = /~\/\.claude\/pickle-rick\/|\/\.claude\/pickle-rick\//;

const noDeployedFileEdit = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow writing to deployed ~/.claude/pickle-rick/ files — edit source, run install.sh',
    },
    messages: {
      noDeployedWrite:
        'Do not write to deployed files under ~/.claude/pickle-rick/. Edit extension/src/ and run install.sh.',
    },
    schema: [],
  },
  create(context) {
    const writeMethods = new Set(['writeFileSync', 'writeSync', 'renameSync', 'unlinkSync', 'appendFileSync']);

    function refersToDeployedPath(node) {
      if (!node) return false;
      if (node.type === 'Literal' && typeof node.value === 'string') {
        return DEPLOYED_PATH_PATTERN.test(node.value);
      }
      if (node.type === 'TemplateLiteral') {
        return node.quasis.some((q) => DEPLOYED_PATH_PATTERN.test(q.value.raw));
      }
      return false;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'fs' &&
          callee.property.type === 'Identifier' &&
          writeMethods.has(callee.property.name)
        ) {
          const firstArg = node.arguments[0];
          if (refersToDeployedPath(firstArg)) {
            context.report({ node, messageId: 'noDeployedWrite' });
          }
        }
      },
    };
  },
};

// ─── Rule: require-number-validation ─────────────────────────────────────────

const requireNumberValidation = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Number() calls on state fields must be followed by Number.isFinite() guard',
    },
    messages: {
      requireIsFinite:
        'Number({{arg}}) must be guarded with Number.isFinite(). Use: `const raw = Number({{arg}}); const val = Number.isFinite(raw) ? raw : 0;`',
    },
    schema: [],
  },
  create(context) {
    // Track variables assigned from Number() calls
    const numberVars = new Map();

    return {
      // Collect: const raw = Number(state.foo)
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === 'Number' &&
          node.init.arguments.length >= 1
        ) {
          const arg = node.init.arguments[0];
          // Only flag state-related args (state.foo, settings.bar, etc.)
          if (arg.type === 'MemberExpression') {
            const varName = node.id.type === 'Identifier' ? node.id.name : null;
            if (varName) {
              numberVars.set(varName, { node: node.init, arg: context.sourceCode.getText(arg) });
            }
          }
        }
      },
      // Check that the variable is used inside Number.isFinite()
      'Program:exit'() {
        const sourceText = context.sourceCode.getText();
        for (const [varName, info] of numberVars) {
          // Look for Number.isFinite(varName) anywhere in the source
          const pattern = new RegExp(`Number\\.isFinite\\(\\s*${varName}\\s*\\)`);
          if (!pattern.test(sourceText)) {
            context.report({
              node: info.node,
              messageId: 'requireIsFinite',
              data: { arg: info.arg },
            });
          }
        }
      },
    };
  },
};

// ─── Rule: no-process-exit-in-library ────────────────────────────────────────

const noProcessExitInLibrary = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow process.exit() in services/ files — services should throw, only bin/ scripts may exit',
    },
    messages: {
      noExitInService:
        'Do not call process.exit() in service/library files. Throw an error instead — let the caller decide how to exit.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const inServices = /services[/\\]/.test(filename);
    if (!inServices) return {};

    return {
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'process' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'exit'
        ) {
          context.report({ node, messageId: 'noExitInService' });
        }
      },
    };
  },
};

// ─── Rule: promise-token-format ──────────────────────────────────────────────

const KNOWN_TOKENS = [
  'EPIC_COMPLETED', 'TASK_COMPLETED', 'EXISTENCE_IS_PAIN',
  'THE_CITADEL_APPROVES', 'PRD_COMPLETE', 'TICKET_SELECTED',
  'ANALYSIS_DONE', 'I AM DONE',
];

const promiseTokenFormat = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Promise tokens must be referenced via PromiseTokens enum, not hardcoded strings',
    },
    messages: {
      useEnum:
        'Hardcoded promise token "{{token}}" — use PromiseTokens.* from types/index.js instead.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Allow the definition files (canonical sources of truth)
    if (/types[/\\]index\./.test(filename)) return {};
    if (/services[/\\]promise-tokens\./.test(filename)) return {};
    // Allow test files
    if (/tests?[/\\]/.test(filename)) return {};

    function checkToken(node, value) {
      if (typeof value !== 'string') return;
      for (const token of KNOWN_TOKENS) {
        if (value === token) {
          context.report({ node, messageId: 'useEnum', data: { token } });
          return;
        }
      }
    }

    return {
      Literal(node) {
        checkToken(node, node.value);
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          for (const token of KNOWN_TOKENS) {
            if (quasi.value.raw.includes(token)) {
              context.report({ node, messageId: 'useEnum', data: { token } });
              return;
            }
          }
        }
      },
    };
  },
};

// ─── Rule: no-sync-in-async ──────────────────────────────────────────────────

const SYNC_FS_METHODS = new Set([
  'readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync',
  'mkdirSync', 'unlinkSync', 'renameSync', 'statSync', 'readdirSync',
  'copyFileSync', 'chmodSync', 'accessSync', 'openSync', 'closeSync',
  'writeSync', 'readSync',
]);

const noSyncInAsync = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Flag synchronous fs calls inside async functions — prefer async alternatives',
    },
    messages: {
      preferAsync:
        'Synchronous fs.{{method}}() inside async function. Consider using fs.promises.{{asyncAlt}}() to avoid blocking the event loop.',
    },
    schema: [],
  },
  create(context) {
    const asyncStack = [];

    function enterFunction(node) {
      asyncStack.push(node.async === true);
    }
    function exitFunction() {
      asyncStack.pop();
    }
    function isInAsync() {
      return asyncStack.length > 0 && asyncStack[asyncStack.length - 1];
    }

    const ASYNC_ALTS = {
      readFileSync: 'readFile', writeFileSync: 'writeFile', appendFileSync: 'appendFile',
      existsSync: 'access', mkdirSync: 'mkdir', unlinkSync: 'unlink',
      renameSync: 'rename', statSync: 'stat', readdirSync: 'readdir',
      copyFileSync: 'copyFile', chmodSync: 'chmod', accessSync: 'access',
      openSync: 'open', closeSync: 'close', writeSync: 'write', readSync: 'read',
    };

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,
      CallExpression(node) {
        if (!isInAsync()) return;
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'fs' &&
          callee.property.type === 'Identifier' &&
          SYNC_FS_METHODS.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: 'preferAsync',
            data: {
              method: callee.property.name,
              asyncAlt: ASYNC_ALTS[callee.property.name] || callee.property.name.replace('Sync', ''),
            },
          });
        }
      },
    };
  },
};

// ─── Rule: spawn-error-handler ───────────────────────────────────────────────

const spawnErrorHandler = {
  meta: {
    type: 'problem',
    docs: {
      description: 'spawn()/exec() calls must have a .on("error") handler',
    },
    messages: {
      requireErrorHandler:
        '{{method}}() call must have a .on("error") handler to catch spawn failures (ENOENT, EACCES, etc.).',
    },
    schema: [],
  },
  create(context) {
    const spawnMethods = new Set(['spawn', 'exec', 'execFile']);
    const spawnVars = new Map(); // varName → node

    return {
      // Track: const proc = spawn(...)
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          spawnMethods.has(node.init.callee.name) &&
          node.id.type === 'Identifier'
        ) {
          spawnVars.set(node.id.name, node.init);
        }
      },
      // Track: proc.on('error', ...)
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'on' &&
          node.callee.object.type === 'Identifier' &&
          node.arguments.length >= 2 &&
          node.arguments[0].type === 'Literal' &&
          node.arguments[0].value === 'error'
        ) {
          spawnVars.delete(node.callee.object.name);
        }
      },
      'Program:exit'() {
        for (const [varName, node] of spawnVars) {
          // Check source for .on('error') with this var (handles chaining patterns)
          const sourceText = context.sourceCode.getText();
          const chainPattern = new RegExp(`${varName}\\.on\\(\\s*['"]error['"]`);
          if (!chainPattern.test(sourceText)) {
            context.report({
              node,
              messageId: 'requireErrorHandler',
              data: { method: sourceText.slice(node.range?.[0] ?? 0, (node.range?.[0] ?? 0) + 5).includes('exec') ? 'exec' : 'spawn' },
            });
          }
        }
      },
    };
  },
};

// ─── Rule: no-hardcoded-timeout ──────────────────────────────────────────────

const noHardcodedTimeout = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Timeouts >5000ms should come from settings or Defaults, not magic numbers',
    },
    messages: {
      useConfig:
        'Hardcoded timeout {{value}}ms. Use pickle_settings.json or Defaults.* constant instead of magic numbers.',
    },
    schema: [],
  },
  create(context) {
    const timeoutFunctions = new Set(['setTimeout', 'sleep']);

    return {
      CallExpression(node) {
        let funcName = null;
        if (node.callee.type === 'Identifier') {
          funcName = node.callee.name;
        }
        if (!funcName || !timeoutFunctions.has(funcName)) return;

        // sleep(n) — first arg; setTimeout(fn, n) — second arg
        const argIndex = funcName === 'setTimeout' ? 1 : 0;
        const arg = node.arguments[argIndex];
        if (!arg) return;

        if (arg.type === 'Literal' && typeof arg.value === 'number' && arg.value > 5000) {
          context.report({
            node,
            messageId: 'useConfig',
            data: { value: String(arg.value) },
          });
        }
      },
    };
  },
};

// ─── Plugin Export ───────────────────────────────────────────────────────────

const plugin = {
  meta: {
    name: 'eslint-plugin-pickle',
    version: '2.0.0',
  },
  rules: {
    'no-raw-state-write': noRawStateWrite,
    'cli-guard-basename': cliGuardBasename,
    'hook-decision-values': hookDecisionValues,
    'no-unsafe-error-cast': noUnsafeErrorCast,
    'no-gemini-path': noGeminiPath,
    'no-deployed-file-edit': noDeployedFileEdit,
    'require-number-validation': requireNumberValidation,
    'no-process-exit-in-library': noProcessExitInLibrary,
    'promise-token-format': promiseTokenFormat,
    'no-sync-in-async': noSyncInAsync,
    'spawn-error-handler': spawnErrorHandler,
    'no-hardcoded-timeout': noHardcodedTimeout,
  },
};

export default plugin;
