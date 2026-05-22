# ACC Health Insurance Underwriting Automation Platform v4.0.0

End-to-end automation for health insurance underwriting with STP fast-lane, NSTP workflow orchestration, authority-based UW routing, structured information requests, and production integration layer.

## What's New in v4.0

- **STP Fast-Lane**: Instant auto-issuance for clean low-complexity proposals (<30ms). Shadow mode for safe rollout.
- **Authority-Based UW Routing**: Auto-assigns referred cases to the right underwriter by specialty, SA authority, and workload.
- **Structured Info Requests**: AI-suggested tests/docs, customer portal with one-time tokens, automated reminders.
- **Production Integrations**: AWS SES email, MSG91/Gupshup SMS, Meta WhatsApp, PAS adapter, outbound webhooks.
- **6 bug fixes** in the existing codebase found during development.
- **176 automated test assertions**, 0 failures.

## Quick Start

```bash
cd backend && npm install && SKIP_AUTH=true node server.js
# Open http://localhost:10000 in browser
```

## Test Coverage

```bash
node test-stp.js                       # 11 assertions
PORT=10099 node test-stp-e2e.js        # 40 assertions
PORT=10098 node test-uw-routing.js     # 74 assertions
PORT=10097 node test-info-requests.js  # 51 assertions
```

## Deployment

```bash
./deploy.sh "v4.0.0: Full brief compliance"
```

See inline code comments for full API documentation and environment variable reference.
