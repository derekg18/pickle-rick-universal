#!/usr/bin/env node
// DOT pipeline codegen CLI — reads BuilderSpec JSON from stdin, writes BuildResult JSON to stdout.
import * as fs from 'fs';
import * as path from 'path';
import { DotBuilder, BuildError } from '../services/dot-builder.js';
const MAX_INPUT_BYTES = 512 * 1024;
function main() {
    let raw;
    try {
        raw = fs.readFileSync(0, 'utf8');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(JSON.stringify({ error: 'UNEXPECTED_ERROR', message: msg }) + '\n');
        process.exit(2);
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) {
        process.stderr.write(JSON.stringify({ error: 'INPUT_TOO_LARGE', message: `Input exceeds ${MAX_INPUT_BYTES} bytes` }) + '\n');
        process.exit(2);
    }
    let spec;
    try {
        spec = JSON.parse(raw);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(JSON.stringify({ error: 'INVALID_SPEC', message: `JSON parse error: ${msg}` }) + '\n');
        process.exit(1);
    }
    try {
        const result = DotBuilder.fromSpec(spec).build();
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(0);
    }
    catch (err) {
        if (err instanceof BuildError) {
            const be = err;
            process.stderr.write(JSON.stringify({ error: be.code, message: be.message, diagnostics: be.diagnostics }) + '\n');
            process.exit(1);
        }
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(JSON.stringify({ error: 'UNEXPECTED_ERROR', message: msg }) + '\n');
        process.exit(2);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'dot-builder-cli.js') {
    main();
}
