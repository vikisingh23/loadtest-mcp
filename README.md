# @neuraforge/loadtest-mcp

MCP server for load testing APIs. Run load tests, stress tests, and detect performance regressions — all from your AI coding assistant.

Uses [autocannon](https://github.com/mcollina/autocannon) (pure Node.js, no system dependencies).

## Install

```json
{
  "mcpServers": {
    "loadtest": {
      "command": "npx",
      "args": ["-y", "@neuraforge/loadtest-mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `run_load_test` | Run load test against endpoints. Returns latency percentiles, RPS, error rates, pass/fail. |
| `stress_test` | Stepped ramp from min to max connections to find the breaking point. |
| `compare_results` | Compare baseline vs current results for regression detection. |

### run_load_test

```json
{
  "baseUrl": "http://localhost:3000",
  "endpoints": [{ "method": "GET", "path": "/api/users" }],
  "connections": 10,
  "duration": 30,
  "thresholds": { "p95": 500, "p99": 1500, "errorRate": 0.01 }
}
```

### stress_test

```json
{
  "baseUrl": "http://localhost:3000",
  "endpoint": { "method": "GET", "path": "/api/users" },
  "minConnections": 10,
  "maxConnections": 200,
  "step": 20,
  "stepDuration": 15
}
```

### compare_results

```json
{
  "baselinePath": "results/baseline.json",
  "currentPath": "results/current.json",
  "regressionThreshold": 10
}
```

## License

Apache 2.0

Part of [NeuraForge AI](https://github.com/vikisingh23/neuraforge-ai).
