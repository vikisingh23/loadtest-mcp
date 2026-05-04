#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import autocannon from 'autocannon';
import fs from 'fs';
import path from 'path';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function buildAutocannonOpts(config) {
  const { baseUrl, endpoints, connections, duration, pipelining, headers, timeout } = config;

  // For single endpoint
  if (endpoints.length === 1) {
    const ep = endpoints[0];
    return {
      url: `${baseUrl}${ep.path}`,
      method: (ep.method || 'GET').toUpperCase(),
      connections: connections || 10,
      duration: duration || 30,
      pipelining: pipelining || 1,
      timeout: timeout || 10,
      headers: { ...headers, ...(ep.headers || {}), ...(ep.body ? { 'Content-Type': 'application/json' } : {}) },
      body: ep.body ? JSON.stringify(ep.body) : undefined,
    };
  }

  // For multiple endpoints — use requests array
  const requests = endpoints.map(ep => ({
    method: (ep.method || 'GET').toUpperCase(),
    path: ep.path,
    headers: { ...(ep.headers || {}), ...(ep.body ? { 'Content-Type': 'application/json' } : {}) },
    body: ep.body ? JSON.stringify(ep.body) : undefined,
  }));

  return {
    url: baseUrl,
    connections: connections || 10,
    duration: duration || 30,
    pipelining: pipelining || 1,
    timeout: timeout || 10,
    headers: headers || {},
    requests,
  };
}

function formatResult(result) {
  return {
    url: result.url,
    duration: `${result.duration}s`,
    connections: result.connections,
    pipelining: result.pipelining,
    requests: {
      total: result.requests.total,
      average: result.requests.average,
      perSecond: Math.round(result.requests.total / result.duration),
      min: result.requests.min,
      max: result.requests.max,
    },
    latency: {
      avg: `${result.latency.average}ms`,
      min: `${result.latency.min}ms`,
      max: `${result.latency.max}ms`,
      p50: `${result.latency.p50}ms`,
      p90: `${result.latency.p90}ms`,
      p95: `${result.latency.p95 || result.latency.p97_5}ms`,
      p99: `${result.latency.p99}ms`,
      p999: `${result.latency.p99_9}ms`,
    },
    throughput: {
      average: formatBytes(result.throughput.average) + '/s',
      total: formatBytes(result.throughput.total),
    },
    errors: result.errors,
    timeouts: result.timeouts,
    statusCodes: {
      '2xx': result['2xx'],
      '3xx': result['3xx'],
      '4xx': result['4xx'],
      '5xx': result['5xx'],
      non2xx: result.non2xx,
    },
    mismatches: result.mismatches,
  };
}

function analyzeResult(result, thresholds = {}) {
  const t = {
    p95: thresholds.p95 || 500,
    p99: thresholds.p99 || 1500,
    errorRate: thresholds.errorRate || 0.01,
    ...thresholds,
  };

  const totalReqs = result.requests.total;
  const errorCount = result.errors + result.timeouts + (result.non2xx || 0);
  const errorRate = totalReqs > 0 ? errorCount / totalReqs : 0;
  const p95 = result.latency.p95 || result.latency.p97_5;
  const p99 = result.latency.p99;

  const checks = [
    { name: `p95 < ${t.p95}ms`, value: `${p95}ms`, passed: p95 < t.p95 },
    { name: `p99 < ${t.p99}ms`, value: `${p99}ms`, passed: p99 < t.p99 },
    { name: `error rate < ${(t.errorRate * 100).toFixed(1)}%`, value: `${(errorRate * 100).toFixed(2)}%`, passed: errorRate < t.errorRate },
  ];

  return {
    passed: checks.every(c => c.passed),
    checks,
    errorRate: `${(errorRate * 100).toFixed(2)}%`,
    rps: Math.round(result.requests.total / result.duration),
  };
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'load-test-server', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'run_load_test',
    description: 'Run a load test against API endpoints. Uses autocannon (Node.js, cross-platform — no system dependencies). Returns latency percentiles, RPS, error rates, and pass/fail analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: 'Base URL (e.g., http://localhost:3001)' },
        endpoints: {
          type: 'array',
          description: 'Array of {method, path, body, headers}. For single endpoint, all connections hit it. For multiple, they rotate.',
          items: { type: 'object' },
        },
        connections: { type: 'number', description: 'Concurrent connections / virtual users (default: 10)' },
        duration: { type: 'number', description: 'Test duration in seconds (default: 30)' },
        pipelining: { type: 'number', description: 'HTTP pipelining factor (default: 1)' },
        headers: { type: 'object', description: 'Global headers (e.g., Authorization)' },
        thresholds: {
          type: 'object',
          description: 'Pass/fail thresholds: {p95: 500, p99: 1500, errorRate: 0.01}',
        },
        saveResultPath: { type: 'string', description: 'Path to save JSON results for later comparison' },
      },
      required: ['baseUrl', 'endpoints'],
    },
  },
  {
    name: 'stress_test',
    description: 'Run a stepped stress test — ramps connections from min to max in steps to find the breaking point.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string' },
        endpoint: { type: 'object', description: '{method, path, body, headers}' },
        minConnections: { type: 'number', description: 'Starting connections (default: 10)' },
        maxConnections: { type: 'number', description: 'Max connections (default: 200)' },
        step: { type: 'number', description: 'Connection increment per step (default: 20)' },
        stepDuration: { type: 'number', description: 'Seconds per step (default: 15)' },
        headers: { type: 'object' },
        saveResultPath: { type: 'string' },
      },
      required: ['baseUrl', 'endpoint'],
    },
  },
  {
    name: 'compare_results',
    description: 'Compare two saved load test result files for regression detection.',
    inputSchema: {
      type: 'object',
      properties: {
        baselinePath: { type: 'string', description: 'Path to baseline JSON results' },
        currentPath: { type: 'string', description: 'Path to current JSON results' },
        regressionThreshold: { type: 'number', description: 'Max allowed % degradation (default: 10)' },
      },
      required: ['baselinePath', 'currentPath'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

  try {
    switch (name) {

      case 'run_load_test': {
        const opts = buildAutocannonOpts(args);
        const result = await autocannon(opts);
        const formatted = formatResult(result);
        const analysis = analyzeResult(result, args.thresholds);

        if (args.saveResultPath) {
          const outPath = path.resolve(args.saveResultPath);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, JSON.stringify({ raw: result, formatted, analysis, timestamp: new Date().toISOString() }, null, 2));
          formatted.savedTo = outPath;
        }

        return json({ ...formatted, analysis });
      }

      case 'stress_test': {
        const min = args.minConnections || 10;
        const max = args.maxConnections || 200;
        const step = args.step || 20;
        const stepDuration = args.stepDuration || 15;
        const steps = [];
        let breakingPoint = null;

        for (let conns = min; conns <= max; conns += step) {
          const opts = buildAutocannonOpts({
            baseUrl: args.baseUrl,
            endpoints: [args.endpoint],
            connections: conns,
            duration: stepDuration,
            headers: args.headers,
          });

          const result = await autocannon(opts);
          const p95 = result.latency.p95 || result.latency.p97_5;
          const errorCount = result.errors + result.timeouts + (result.non2xx || 0);
          const errorRate = result.requests.total > 0 ? errorCount / result.requests.total : 0;

          const stepResult = {
            connections: conns,
            rps: Math.round(result.requests.total / result.duration),
            p50: `${result.latency.p50}ms`,
            p95: `${p95}ms`,
            p99: `${result.latency.p99}ms`,
            errorRate: `${(errorRate * 100).toFixed(2)}%`,
            errors: errorCount,
          };
          steps.push(stepResult);

          // Detect breaking point: error rate > 5% or p95 > 5s
          if (!breakingPoint && (errorRate > 0.05 || p95 > 5000)) {
            breakingPoint = { connections: conns, reason: errorRate > 0.05 ? 'error rate > 5%' : 'p95 > 5s' };
          }
        }

        const output = {
          endpoint: `${args.endpoint.method || 'GET'} ${args.baseUrl}${args.endpoint.path}`,
          stepsRun: steps.length,
          breakingPoint: breakingPoint || { connections: `>${max}`, reason: 'not reached within test range' },
          steps,
        };

        if (args.saveResultPath) {
          const outPath = path.resolve(args.saveResultPath);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, JSON.stringify({ ...output, timestamp: new Date().toISOString() }, null, 2));
          output.savedTo = outPath;
        }

        return json(output);
      }

      case 'compare_results': {
        const bp = path.resolve(args.baselinePath);
        const cp = path.resolve(args.currentPath);
        if (!fs.existsSync(bp)) return json({ error: `Baseline not found: ${bp}` });
        if (!fs.existsSync(cp)) return json({ error: `Current not found: ${cp}` });

        const baseline = JSON.parse(fs.readFileSync(bp, 'utf-8'));
        const current = JSON.parse(fs.readFileSync(cp, 'utf-8'));
        const threshold = args.regressionThreshold || 10;

        const bRaw = baseline.raw || baseline;
        const cRaw = current.raw || current;

        const compare = (bVal, cVal, label) => {
          if (!bVal || !cVal) return null;
          const change = bVal > 0 ? ((cVal - bVal) / bVal) * 100 : 0;
          return { baseline: bVal, current: cVal, changePercent: Math.round(change * 100) / 100, label };
        };

        const bP95 = bRaw.latency?.p95 || bRaw.latency?.p97_5;
        const cP95 = cRaw.latency?.p95 || cRaw.latency?.p97_5;

        const comparisons = {
          p50: compare(bRaw.latency?.p50, cRaw.latency?.p50, 'p50 latency'),
          p95: compare(bP95, cP95, 'p95 latency'),
          p99: compare(bRaw.latency?.p99, cRaw.latency?.p99, 'p99 latency'),
          avg: compare(bRaw.latency?.average, cRaw.latency?.average, 'avg latency'),
          rps: compare(bRaw.requests?.average, cRaw.requests?.average, 'requests/sec'),
        };

        const isRegression = (comparisons.p95?.changePercent || 0) > threshold || (comparisons.p99?.changePercent || 0) > threshold;

        return json({
          regression: isRegression,
          threshold: `${threshold}%`,
          comparisons,
          verdict: isRegression
            ? `⚠️ REGRESSION: p95 changed by ${comparisons.p95?.changePercent}% (threshold: ${threshold}%)`
            : `✅ PASS: Within ${threshold}% of baseline`,
        });
      }

      default:
        return json({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return json({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
