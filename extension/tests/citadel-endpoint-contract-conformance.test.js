import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkEndpointContractConformance } from '../services/citadel/endpoint-contract-conformance.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function endpoint(method, endpointPath) {
  return {
    method,
    path: endpointPath,
    line: 1,
    text: `| ${method} ${endpointPath} | fixture |`,
  };
}

function statusRow(method, endpointPath, statusCode, errorMessage) {
  return {
    endpointMethod: method,
    endpointPath,
    statusCode,
    errorMessage,
    line: 2,
    text: `| ${method} ${endpointPath} | ${statusCode} | ${errorMessage ?? ''} |`,
  };
}

describe('checkEndpointContractConformance', () => {
  test('passes when a NestJS controller method has documented status and message evidence', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-endpoint-contract-pass-'));
    try {
      writeFile(
        repoRoot,
        'src/runs.controller.ts',
        [
          "import { Controller, Get, NotFoundException } from '@nestjs/common';",
          '',
          "@Controller('/api/runs')",
          'export class RunsController {',
          "  @Get(':runId/comparison')",
          '  getComparison() {',
          "    throw new NotFoundException('Comparison not found');",
          '  }',
          '}',
          '',
        ].join('\n'),
      );

      const report = checkEndpointContractConformance(
        [endpoint('GET', '/api/runs/{runId}/comparison')],
        [statusRow('GET', '/api/runs/{runId}/comparison', 404, 'Comparison not found')],
        { repoRoot },
      );

      assert.equal(report.findings.length, 0);
      assert.equal(report.summary.totalRows, 1);
      assert.equal(report.rows[0].controller?.file, 'src/runs.controller.ts');
      assert.equal(report.rows[0].statusEvidence?.line, 7);
      assert.equal(report.rows[0].messageEvidence?.line, 7);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports missing documented status codes and messages', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-endpoint-contract-missing-'));
    try {
      writeFile(
        repoRoot,
        'src/retry.controller.ts',
        [
          "import { Controller, Post } from '@nestjs/common';",
          '',
          "@Controller('api/runs')",
          'export class RetryController {',
          "  @Post(':runId/retry')",
          '  retry() {',
          "    return { ok: false, reason: 'Different text' };",
          '  }',
          '}',
          '',
        ].join('\n'),
      );

      const report = checkEndpointContractConformance(
        [endpoint('POST', '/api/runs/{runId}/retry')],
        [statusRow('POST', '/api/runs/{runId}/retry', 409, 'Retry is already running')],
        { repoRoot },
      );

      assert.deepEqual(
        report.findings.map((finding) => [finding.severity, finding.statusCodeRow.statusCode, finding.message]),
        [
          ['Medium', 409, 'POST /api/runs/{runId}/retry is missing documented 409.'],
          [
            'Medium',
            409,
            'POST /api/runs/{runId}/retry is missing documented error message "Retry is already running".',
          ],
        ],
      );
      assert.equal(report.summary.missingStatusCodes, 1);
      assert.equal(report.summary.missingMessages, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports missing 403 auth paths as high severity', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-endpoint-contract-403-'));
    try {
      writeFile(
        repoRoot,
        'src/admin.controller.ts',
        [
          "import { Controller, Delete } from '@nestjs/common';",
          '',
          "@Controller('api/admin')",
          'export class AdminController {',
          "  @Delete(':id')",
          '  remove() {',
          '    return { deleted: true };',
          '  }',
          '}',
          '',
        ].join('\n'),
      );

      const report = checkEndpointContractConformance(
        [endpoint('DELETE', '/api/admin/{id}')],
        [statusRow('DELETE', '/api/admin/{id}', 403, 'Forbidden')],
        { repoRoot },
      );

      assert.equal(report.findings[0].severity, 'High');
      assert.match(report.findings[0].message, /missing documented 403/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports missing controller methods for documented endpoint rows', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-endpoint-contract-controller-'));
    try {
      writeFile(
        repoRoot,
        'src/health.controller.ts',
        [
          "import { Controller, Get } from '@nestjs/common';",
          '',
          "@Controller('health')",
          'export class HealthController {',
          "  @Get('ready')",
          "  ready() { return 'ok'; }",
          '}',
          '',
        ].join('\n'),
      );

      const report = checkEndpointContractConformance(
        [endpoint('GET', '/api/runs/{runId}/comparison')],
        [statusRow('GET', '/api/runs/{runId}/comparison', 404, 'Comparison not found')],
        { repoRoot },
      );

      assert.equal(report.summary.missingControllers, 1);
      assert.equal(report.findings.length, 1);
      assert.match(report.findings[0].message, /No controller method found/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
