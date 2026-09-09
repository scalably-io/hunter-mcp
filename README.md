# Hunter MCP

Hunter.io MCP server. 11 tools cover domain search, email finding and verification, enrichment, company discovery, and lead management.

<!-- mcp-name: io.scalably/hunter-mcp -->

## Install

Claude Code:

```bash
claude mcp add hunter -e HUNTER_API_KEY=your-key -- npx -y @scalably-io/hunter-mcp
```

Codex:

```bash
codex mcp add hunter --env HUNTER_API_KEY=your-key -- npx -y @scalably-io/hunter-mcp
```

Claude Desktop: download `hunter-mcp.mcpb` from the latest GitHub release and open it.

## Setup

1. Create an API key at hunter.io/api-keys.
2. `create_lead` writes to your Hunter leads list and is the only non-read tool; the other 10 tools are read-only.

## Tools (11)

| Tool | What it does |
|---|---|
| `account_info` | Read the Hunter v2 account plan and exact current credit usage, including remaining unified or per-type balances |
| `domain_search` | Search Hunter v2 emails for one domain/company with current people, verification, location, job-title, decision-maker, aggregation, and offset filters |
| `email_finder` | Find and automatically verify the most likely professional email from a company/domain plus name, or directly from a LinkedIn handle |
| `email_verifier` | Verify one email address with Hunter v2 and return exact deliverability, score, SMTP/MX, accept-all, webmail, disposable, and source evidence |
| `email_count` | Count Hunter email coverage for a domain/company, optionally limited to personal or generic addresses, without returning addresses |
| `email_enrichment` | Enrich a person from an email address or LinkedIn handle using Hunter v2, optionally in Clearbit-compatible format |
| `company_enrichment` | Enrich a company from its domain using Hunter v2, optionally in Clearbit-compatible format |
| `combined_enrichment` | Enrich both a person and their company from one email using Hunter v2, optionally in Clearbit-compatible format |
| `discover` | Use Hunter Discover v2 to find companies from current natural-language or structured organization, location, industry, headcount, type, year, keyword, technology, and funding filters |
| `create_lead` | Create one Hunter lead from a required email and optional current lead fields, list placement, and custom attributes. This is a single-attempt mutation |
| `list_leads` | List Hunter leads with current list, identity, company, status, verification, activity/date, location, tag, campaign, user, confidence, custom-attribute, query, and offset filters |

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `HUNTER_API_KEY` | yes | Hunter.io API key from hunter.io/api-keys |
| `HUNTER_API_BASE` | no | Override the Hunter API base URL (default `https://api.hunter.io/v2`) |
| `HUNTER_TIMEOUT_MS` | no | Per-request timeout in milliseconds (default 30000) |
| `HUNTER_RETRY_BASE_MS` | no | Base delay in milliseconds for the GET retry backoff (default 500) |

## Reply shape

Every tool returns plain JSON with `status` (`succeeded`, `partial`, `no_op`), `operation`, `summary`, `target`, `result`, `proof`, `warnings`, `recovery`. Failures throw a plain error string: `<code>: <message> <hint>`.

## Limits

Hunter's per-plan request quotas surface in `account_info`.

## Verify

Each release lists the package version, the `.mcpb` sha256 and the production commit it was derived from in CHANGELOG.md. CI runs the tests and a clean install of the packed tarball on every push.

## Privacy Policy

This server runs locally, on your machine, under your own credentials. It collects no personal data, contains no telemetry, stores nothing persistently, and talks only to the vendor API it wraps. No third party, including Scalably, receives your data. Contact: hello@scalably.io. Canonical copy: https://scalably.io/connector-privacy.html

## License

MIT. Copyright Scalably.
