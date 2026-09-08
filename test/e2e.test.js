import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textOf = (response) => response.result?.content?.find((item) => item.type === 'text')?.text || '';

function client(origin, apiKey = 'test-key') {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      HUNTER_API_KEY: apiKey,
      HUNTER_API_BASE: origin,
      HUNTER_RETRY_BASE_MS: '1',
      HUNTER_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  const request = (method, params) => {
    const requestId = id++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}: ${stderr}`)), 15_000);
      pending.set(requestId, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    return promise;
  };
  return {
    async init() {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hunter-test', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    list: () => request('tools/list', {}),
    call: (name, args = {}) => request('tools/call', { name, arguments: args }),
    async close() {
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await done;
    },
  };
}

test('Hunter v2 MCP exposes its exact 11-tool surface with truthful outcomes', async () => {
  const seen = [];
  const counts = new Map();
  const targetCounts = new Map();
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://test');
      const key = `${req.method} ${url.pathname}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      const parsedBody = rawBody ? JSON.parse(rawBody) : null;
      const targetKey = `${key}|${url.searchParams.get('domain') ?? parsedBody?.domain ?? ''}`;
      targetCounts.set(targetKey, (targetCounts.get(targetKey) || 0) + 1);
      seen.push({ key, url, body: parsedBody, apiKey: req.headers['x-api-key'] });
      const send = (status, value, headers = {}) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-request-id', `request-${seen.length}`);
        for (const [name, headerValue] of Object.entries(headers)) res.setHeader(name, headerValue);
        res.end(JSON.stringify(value));
      };

      if (url.pathname === '/account') {
        return send(200, {
          data: {
            team_id: 7,
            plan_name: 'Growth',
            requests: {
              credits: { used: 10, available: 100, remaining: 90 },
              searches: { used: 6, available: 80, remaining: 74 },
              verifications: { used: 4, available: 20, remaining: 16 },
            },
            calls: { used: 10, available: 100 },
          },
        });
      }

      if (url.pathname === '/domain-search') {
        const domain = url.searchParams.get('domain') ?? parsedBody?.domain;
        if (domain === 'rate.example' && targetCounts.get(`${key}|${domain}`) < 3) {
          return send(403, { errors: [{ id: 'rate_limit', details: 'slow down' }] }, { 'retry-after': '0' });
        }
        if (domain === 'quota.example') return send(429, { errors: [{ id: 'quota', details: 'allowance exhausted' }] });
        if (domain === 'drop.example') return req.socket.destroy();
        if (domain === 'ambiguous.example') return send(503, { errors: [{ id: 'upstream', details: 'uncertain' }] });
        const emails = domain === 'empty.example'
          ? []
          : [{ value: 'one@example.com', verification: { status: 'valid' } }, { value: 'two@example.com', verification: { status: 'accept_all' } }];
        return send(200, {
          data: { domain, emails },
          meta: {
            results: emails.length ? 5 : 0,
            results_approximate: emails.length > 0,
            limit: parsedBody?.limit ?? Number(url.searchParams.get('limit') ?? 10),
            offset: parsedBody?.offset ?? Number(url.searchParams.get('offset') ?? 0),
          },
        });
      }

      if (url.pathname === '/email-finder') {
        const none = url.searchParams.get('linkedin_handle') === 'none';
        return send(200, { data: { email: none ? null : 'found@example.com', verification: none ? null : { status: 'valid' } } });
      }
      if (url.pathname === '/email-verifier') {
        if (url.searchParams.get('email') === 'privacy@example.com') {
          return send(451, { errors: [{ id: 'claimed_email', details: 'do not process' }] });
        }
        return send(200, { data: { email: url.searchParams.get('email'), status: 'valid', score: 100 } });
      }
      if (url.pathname === '/email-count') return send(200, { data: { total: 0, personal_emails: 0, generic_emails: 0 } });
      if (url.pathname === '/people/find') return send(200, { data: { email: url.searchParams.get('email'), name: { fullName: 'Person' } } });
      if (url.pathname === '/companies/find') return send(200, { data: { domain: url.searchParams.get('domain'), name: 'Company' } });
      if (url.pathname === '/combined/find') return send(200, { data: { person: { email: url.searchParams.get('email') }, company: { domain: 'example.com' } } });
      if (url.pathname === '/discover') {
        return send(200, {
          data: [{ domain: 'one.example', organization: 'One' }],
          meta: { results: 3, limit: parsedBody?.limit ?? 100, offset: parsedBody?.offset ?? 0, filters: parsedBody },
        });
      }
      if (url.pathname === '/leads' && req.method === 'POST') {
        if (parsedBody.email === 'ambiguous@example.com') return send(503, { errors: [{ id: 'upstream', details: 'uncertain write' }] });
        return send(201, { data: { id: 42, ...parsedBody } });
      }
      if (url.pathname === '/leads' && req.method === 'GET') {
        return send(200, {
          data: { leads: [{ id: 1, email: 'a@example.com' }, { id: 2, email: 'b@example.com' }] },
          meta: { count: 2, total: 5, params: { limit: Number(url.searchParams.get('limit') ?? 20), offset: Number(url.searchParams.get('offset') ?? 0) } },
        });
      }
      return send(404, { errors: [{ id: 'not_found', details: 'route missing' }] });
    });
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const origin = `http://localhost:${server.address().port}`;
  const mcp = client(origin);

  try {
    await mcp.init();
    const listed = (await mcp.list()).result.tools;
    const expected = [
      'account_info', 'combined_enrichment', 'company_enrichment', 'create_lead',
      'discover', 'domain_search', 'email_count', 'email_enrichment',
      'email_finder', 'email_verifier', 'list_leads',
    ];
    assert.deepEqual(listed.map((tool) => tool.name).sort(), expected);

    const invalidFinder = await mcp.call('email_finder', { domain: 'example.com' });
    assert.equal(invalidFinder.error.code, -32602);
    assert.match(invalidFinder.error.message, /full_name|first_name/i);

    const account = JSON.parse(textOf(await mcp.call('account_info')));
    assert.equal(account.status, 'succeeded');
    assert.equal('schema' in account, false);
    assert.equal(account.proof.quotaSnapshot.credits.remaining, 90);
    assert.equal(account.proof.callsDeprecated, true);
    assert.equal(account.result._meta.requestId, 'request-1');

    const domain = JSON.parse(textOf(await mcp.call('domain_search', {
      domain: 'example.com',
      limit: '2',
      seniority: ['senior', 'executive'],
      department: ['sales', 'marketing'],
      required_field: ['full_name', 'position'],
      verification_status: ['valid', 'accept_all'],
      job_titles: ['CTO', 'VP Engineering'],
      decision_maker: true,
      aggregations: true,
    })));
    assert.equal(domain.status, 'succeeded');
    assert.equal(domain.proof.pagination.totalApproximate, true);
    assert.equal(domain.proof.pagination.complete, false);
    assert.equal(domain.proof.pagination.nextOffset, 2);
    assert.equal(domain.warnings.length, 1);
    const domainRequest = seen.find((request) => request.key === 'GET /domain-search' && request.url.searchParams.get('domain') === 'example.com');
    assert.equal(domainRequest.apiKey, 'test-key');
    assert.equal(domainRequest.url.searchParams.get('seniority'), 'senior,executive');
    assert.equal(domainRequest.url.searchParams.get('department'), 'sales,marketing');
    assert.equal(domainRequest.url.searchParams.get('job_titles'), 'CTO,VP Engineering');

    const located = JSON.parse(textOf(await mcp.call('domain_search', {
      domain: 'location.example',
      limit: 2,
      location: { include: [{ city: 'Paris', country: 'FR' }] },
    })));
    assert.equal(located.result._meta.method, 'POST');
    const locationRequest = seen.find((request) => request.key === 'POST /domain-search' && request.body?.domain === 'location.example');
    assert.deepEqual(locationRequest.body.location, { include: [{ city: 'Paris', country: 'FR' }] });

    const rate = JSON.parse(textOf(await mcp.call('domain_search', { domain: 'rate.example' })));
    assert.equal(rate.status, 'succeeded');
    assert.equal([...seen].filter((request) => request.key === 'GET /domain-search' && request.url.searchParams.get('domain') === 'rate.example').length, 3);

    const quota = await mcp.call('domain_search', { domain: 'quota.example' });
    assert.equal(quota.result.isError, true);
    assert.match(textOf(quota), /^usage_exhausted:/);

    const dropped = await mcp.call('domain_search', { domain: 'drop.example' });
    assert.equal(dropped.result.isError, true);
    assert.match(textOf(dropped), /^ambiguous_read_request:/);
    assert.equal([...seen].filter((request) => request.key === 'GET /domain-search' && request.url.searchParams.get('domain') === 'drop.example').length, 1);

    const ambiguousPaid = await mcp.call('domain_search', {
      domain: 'ambiguous.example',
      location: { include: [{ country: 'US' }] },
    });
    assert.equal(ambiguousPaid.result.isError, true);
    assert.match(textOf(ambiguousPaid), /^ambiguous_paid_request:/);

    const noFinder = JSON.parse(textOf(await mcp.call('email_finder', { linkedin_handle: 'none' })));
    assert.equal(noFinder.status, 'no_op');
    assert.match(noFinder.proof.cost, /no credit/i);

    const privacy = await mcp.call('email_verifier', { email: 'privacy@example.com' });
    assert.equal(privacy.result.isError, true);
    assert.match(textOf(privacy), /^privacy_restricted:.*Do not retry/i);

    const count = JSON.parse(textOf(await mcp.call('email_count', { company: 'Empty Company', type: 'personal' })));
    assert.equal(count.status, 'no_op');
    assert.equal(count.proof.addressDataReturned, false);

    const person = JSON.parse(textOf(await mcp.call('email_enrichment', { email: 'person@example.com', clearbit_format: true })));
    assert.equal(person.result.data.data.name.fullName, 'Person');
    const personRequest = seen.find((request) => request.key === 'GET /people/find');
    assert.equal(personRequest.url.searchParams.get('clearbit_format'), 'true');

    const company = JSON.parse(textOf(await mcp.call('company_enrichment', { domain: 'example.com' })));
    assert.equal(company.result.data.data.name, 'Company');
    const combined = JSON.parse(textOf(await mcp.call('combined_enrichment', { email: 'person@example.com' })));
    assert.equal(combined.result.data.data.company.domain, 'example.com');

    const discover = JSON.parse(textOf(await mcp.call('discover', {
      industry: { include: ['Software'], exclude: ['Staffing'] },
      headcount: ['51-200'],
      technology: { include: ['stripe'], match: 'any' },
      headquarters_location: { include: [{ country: 'DE', city: 'Berlin' }] },
      limit: 1,
    })));
    assert.equal(discover.status, 'succeeded');
    assert.equal(discover.proof.cost, 'free');
    assert.equal(discover.proof.pagination.nextOffset, 1);
    const discoverRequest = seen.find((request) => request.key === 'POST /discover');
    assert.equal(discoverRequest.body.filters, undefined);
    assert.deepEqual(discoverRequest.body.industry, { include: ['Software'], exclude: ['Staffing'] });
    assert.deepEqual(discoverRequest.body.headquarters_location, { include: [{ country: 'DE', city: 'Berlin' }] });

    const invalidLead = await mcp.call('create_lead', { first_name: 'No', last_name: 'Email' });
    assert.equal(invalidLead.error.code, -32602);
    assert.match(invalidLead.error.message, /email/i);

    const created = JSON.parse(textOf(await mcp.call('create_lead', {
      email: 'lead@example.com',
      first_name: 'Lead',
      leads_list_ids: ['4', '5'],
      custom_attributes: { customer_id: 'customer-1' },
    })));
    assert.equal(created.status, 'succeeded');
    assert.equal(created.proof.readBack, false);
    assert.equal(created.proof.leadId, 42);
    const createRequest = seen.find((request) => request.key === 'POST /leads' && request.body?.email === 'lead@example.com');
    assert.deepEqual(createRequest.body.leads_list_ids, [4, 5]);
    assert.deepEqual(createRequest.body.custom_attributes, { customer_id: 'customer-1' });

    const ambiguousWrite = await mcp.call('create_lead', { email: 'ambiguous@example.com' });
    assert.equal(ambiguousWrite.result.isError, true);
    assert.match(textOf(ambiguousWrite), /^ambiguous_write:/);
    assert.equal([...seen].filter((request) => request.key === 'POST /leads' && request.body?.email === 'ambiguous@example.com').length, 1);

    const leads = JSON.parse(textOf(await mcp.call('list_leads', {
      positions: ['CEO', 'CTO'],
      sending_statuses: ['sent', 'replied'],
      campaign_membership: 'none',
      location: { country: { include: ['US', 'FR'] } },
      confidence_score: { from: '80' },
      custom_attributes: { campaign_id: 'q3' },
      limit: '2',
    })));
    assert.equal(leads.proof.pagination.returnedRows, 2);
    assert.equal(leads.proof.pagination.nextOffset, 2);
    const listRequest = seen.find((request) => request.key === 'GET /leads');
    assert.deepEqual(listRequest.url.searchParams.getAll('position[]'), ['CEO', 'CTO']);
    assert.deepEqual(listRequest.url.searchParams.getAll('sending_status[]'), ['sent', 'replied']);
    assert.equal(listRequest.url.searchParams.get('campaign_ids'), '~');
    assert.deepEqual(listRequest.url.searchParams.getAll('location[country][include][]'), ['US', 'FR']);
    assert.equal(listRequest.url.searchParams.get('confidence_score[from]'), '80');
    assert.equal(listRequest.url.searchParams.get('custom_attributes[campaign_id]'), 'q3');
  } finally {
    await mcp.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Hunter starts without a key and returns a not-configured failure', async () => {
  const mcp = client('http://localhost:1', '');
  try {
    await mcp.init();
    const response = await mcp.call('account_info');
    assert.equal(response.result.isError, true);
    assert.match(textOf(response), /^not_configured:/);
  } finally {
    await mcp.close();
  }
});
