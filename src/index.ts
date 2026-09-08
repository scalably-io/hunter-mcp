#!/usr/bin/env node
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { fail, reply } from './reply.js';

const API_BASE = (process.env.HUNTER_API_BASE ?? 'https://api.hunter.io/v2').replace(/\/$/, '');
const API_KEY = process.env.HUNTER_API_KEY ?? '';
const TIMEOUT_MS = Number(process.env.HUNTER_TIMEOUT_MS ?? 30_000);
const RETRY_BASE_MS = Number(process.env.HUNTER_RETRY_BASE_MS ?? 500);

type Method = 'GET' | 'POST';
type RequestKind = 'read' | 'paid_analysis' | 'write';

interface RequestOptions {
  path: string;
  method?: Method;
  query?: Record<string, unknown>;
  body?: unknown;
  kind?: RequestKind;
}

interface HunterResponse {
  body: Record<string, any>;
  httpStatus: number;
  requestId: string | null;
  method: Method;
  path: string;
}

class HunterRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly ambiguous = false,
    readonly changedUnknown = false,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'HunterRequestError';
  }
}

function configured(): void {
  if (!API_KEY) {
    throw new HunterRequestError(
      'HUNTER_API_KEY is not configured',
      'not_configured',
      false,
    );
  }
}

function sanitize(value: string): string {
  let sanitized = value.replace(/(X-API-KEY["':=\s]+)[^\s,"'}]+/gi, '$1[redacted]');
  if (API_KEY) sanitized = sanitized.replaceAll(API_KEY, '[redacted]');
  return sanitized.slice(0, 1_500);
}

function errorDetail(parsed: unknown, fallback: string): string {
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).errors)) {
    const details = (parsed as any).errors
      .slice(0, 5)
      .map((entry: any) => [entry.id, entry.details].filter(Boolean).join(': '))
      .filter(Boolean);
    if (details.length) return details.join('; ');
  }
  return fallback;
}

function classifyHttp(
  status: number,
  detail: string,
  kind: RequestKind,
): HunterRequestError {
  const message = sanitize(detail);
  if (status === 400) {
    return new HunterRequestError(`Hunter rejected the request (400): ${message}`, 'invalid_request', false, false, false, status);
  }
  if (status === 401) {
    return new HunterRequestError(`Hunter authentication failed (401): ${message}`, 'authentication_failed', false, false, false, status);
  }
  if (status === 403) {
    return new HunterRequestError(`Hunter rate limited the request (403): ${message}`, 'rate_limited', true, false, false, status);
  }
  if (status === 404) {
    return new HunterRequestError(`Hunter resource was not found (404): ${message}`, 'not_found', false, false, false, status);
  }
  if (status === 422) {
    return new HunterRequestError(`Hunter could not apply the request (422): ${message}`, 'unprocessable_request', false, false, false, status);
  }
  if (status === 429) {
    return new HunterRequestError(`Hunter usage allowance is exhausted (429): ${message}`, 'usage_exhausted', false, false, false, status);
  }
  if (status === 451) {
    return new HunterRequestError(`Hunter refused personal-data processing (451): ${message}`, 'privacy_restricted', false, false, false, status);
  }
  if (status >= 500) {
    return new HunterRequestError(
      `Hunter upstream failure (${status}): ${message}`,
      kind === 'write'
        ? 'ambiguous_write'
        : kind === 'paid_analysis'
          ? 'ambiguous_paid_request'
          : 'upstream_failure',
      kind === 'read',
      kind !== 'read',
      kind === 'write',
      status,
    );
  }
  return new HunterRequestError(`Hunter API failure (${status}): ${message}`, 'hunter_api_error', false, false, false, status);
}

function appendQuery(url: URL, query?: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function retryDelay(response: Response, attempt: number): number {
  const raw = response.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 0), 30_000);
    const dateMs = Date.parse(raw) - Date.now();
    if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs, 0), 30_000);
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, 5_000);
}

async function hunterRequest(options: RequestOptions): Promise<HunterResponse> {
  configured();
  const method = options.method ?? 'GET';
  const kind = options.kind ?? 'read';
  const url = new URL(`${API_BASE}${options.path}`);
  appendQuery(url, options.query);
  const attempts = method === 'GET' ? 3 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'X-API-KEY': API_KEY,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = {};
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (!response.ok) throw classifyHttp(response.status, text, kind);
          throw new HunterRequestError(
            `Hunter returned non-JSON success content (HTTP ${response.status}): ${sanitize(text)}`,
            kind === 'write'
              ? 'ambiguous_write'
              : kind === 'paid_analysis'
                ? 'ambiguous_paid_result'
                : 'invalid_response',
            false,
            method !== 'GET',
            kind === 'write',
            response.status,
          );
        }
      }
      if (!response.ok) {
        if (
          method === 'GET' &&
          attempt < attempts - 1 &&
          (response.status === 403 || response.status >= 500)
        ) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
          continue;
        }
        throw classifyHttp(response.status, errorDetail(parsed, text), kind);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HunterRequestError(
          'Hunter returned an unexpected success payload',
          kind === 'write' ? 'ambiguous_write' : 'invalid_response',
          false,
          method !== 'GET',
          kind === 'write',
          response.status,
        );
      }
      return {
        body: parsed as Record<string, any>,
        httpStatus: response.status,
        requestId: response.headers.get('x-request-id'),
        method,
        path: options.path,
      };
    } catch (error) {
      if (error instanceof HunterRequestError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HunterRequestError(
        `Hunter transport failure: ${sanitize(message)}`,
        kind === 'write'
          ? 'ambiguous_write'
          : kind === 'paid_analysis'
            ? 'ambiguous_paid_request'
            : 'ambiguous_read_request',
        false,
        true,
        kind === 'write',
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HunterRequestError('Hunter request attempts were exhausted', 'upstream_failure', true);
}

function nextAction(error: HunterRequestError): string {
  if (error.code === 'privacy_restricted') {
    return 'Do not retry or process this person\'s personal data.';
  }
  if (error.code === 'ambiguous_write') {
    return 'List Hunter leads by email before deciding whether to repeat the write.';
  }
  if (error.code.startsWith('ambiguous_paid_')) {
    return 'Request execution and credit consumption are unknown; check account usage, then repeat only if the result is still required.';
  }
  if (error.code === 'ambiguous_read_request') {
    return 'Request execution is unknown; retry once only if the result is still required.';
  }
  if (error.code === 'usage_exhausted') {
    return 'Wait for the Hunter allowance reset or increase the plan/credit allowance before retrying.';
  }
  if (error.retryable) return 'Wait for Hunter rate-limit or service recovery, then retry once.';
  return 'Correct the request, identifier, API key, plan entitlement, or precondition before retrying.';
}

async function execute<T>(
  operation: string,
  target: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && !(error instanceof HunterRequestError)) throw error;
    const known = error instanceof HunterRequestError
      ? error
      : new HunterRequestError(error instanceof Error ? error.message : String(error), 'hunter_request_failed', false);
    fail(known.code, known.message, nextAction(known));
  }
}

function apiMeta(response: HunterResponse) {
  return {
    apiVersion: 'v2',
    method: response.method,
    path: response.path,
    httpStatus: response.httpStatus,
    requestId: response.requestId,
  };
}

function arrayData(body: Record<string, any>, path: string[]): unknown[] {
  let value: any = body;
  for (const key of path) value = value?.[key];
  return Array.isArray(value) ? value : [];
}

function paginationProof(
  body: Record<string, any>,
  returned: number,
  requestedLimit: number | undefined,
  requestedOffset: number | undefined,
) {
  const meta = body.meta ?? {};
  const limit = Number(meta.limit ?? meta.params?.limit ?? requestedLimit ?? returned);
  const offset = Number(meta.offset ?? meta.params?.offset ?? requestedOffset ?? 0);
  const totalValue = meta.total ?? meta.results;
  const total = typeof totalValue === 'number' ? totalValue : null;
  const approximate = typeof meta.results_approximate === 'boolean' ? meta.results_approximate : null;
  const complete =
    Number.isFinite(limit) && returned < limit
      ? true
      : total !== null && approximate !== true
        ? offset + returned >= total
        : false;
  return {
    requestedLimit: requestedLimit ?? null,
    effectiveLimit: Number.isFinite(limit) ? limit : null,
    offset: Number.isFinite(offset) ? offset : 0,
    returnedRows: returned,
    total,
    totalApproximate: approximate,
    complete,
    nextOffset: complete ? null : offset + returned,
    possiblyTruncated: !complete,
  };
}

const intInput = (min: number, max?: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
    max === undefined
      ? z.number().int().min(min)
      : z.number().int().min(min).max(max),
  );

const locationItem = z.object({
  continent: z.enum(['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America']).optional(),
  business_region: z.enum(['AMER', 'EMEA', 'APAC', 'LATAM']).optional(),
  country: z.string().length(2).optional(),
  state: z.string().optional(),
  city: z.string().optional(),
}).strict();

const locationFilter = z.object({
  include: z.array(locationItem).max(100).optional(),
  exclude: z.array(locationItem).max(100).optional(),
}).strict();

const stringFilter = z.object({
  include: z.array(z.string()).max(100).optional(),
  exclude: z.array(z.string()).max(100).optional(),
}).strict();

const matchingStringFilter = stringFilter.extend({
  match: z.enum(['any', 'all']).optional(),
}).strict();

const mcp = new FastMCP({ name: 'hunter', version: '1.0.0' });

mcp.addTool({
  name: 'account_info',
  annotations: { title: 'Read account and credits', readOnlyHint: true, openWorldHint: true },
  description: 'Read the Hunter v2 account plan and exact current credit usage, including remaining unified or per-type balances.',
  parameters: z.object({}).strict(),
  execute: async () => execute('account_info', { type: 'hunter_account' }, async () => {
    const response = await hunterRequest({ path: '/account' });
    const requests = response.body.data?.requests ?? null;
    return reply({
      status: 'succeeded',
      operation: 'account_info',
      summary: 'Read Hunter account and quota state.',
      target: { type: 'hunter_account', identifiers: { teamId: response.body.data?.team_id ?? null } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { quotaSnapshot: requests, callsDeprecated: response.body.data?.calls != null },
    });
  }),
});

const domainSearchSchema = z.object({
  domain: z.string().optional(),
  company: z.string().optional(),
  limit: intInput(1, 100).optional(),
  offset: intInput(0).optional(),
  type: z.enum(['personal', 'generic']).optional(),
  seniority: z.array(z.enum(['junior', 'senior', 'executive'])).max(3).optional(),
  department: z.array(z.enum([
    'executive', 'it', 'finance', 'management', 'sales', 'legal', 'support', 'hr',
    'marketing', 'communication', 'education', 'design', 'health', 'operations',
    'product', 'research', 'consulting', 'administrative', 'procurement',
  ])).max(19).optional(),
  decision_maker: z.boolean().optional(),
  required_field: z.array(z.enum(['full_name', 'position', 'phone_number'])).max(3).optional(),
  verification_status: z.array(z.enum(['valid', 'accept_all', 'unknown'])).max(3).optional(),
  location: locationFilter.optional(),
  job_titles: z.array(z.string()).max(100).optional(),
  aggregations: z.boolean().optional(),
}).strict().superRefine((args, context) => {
  if (!args.domain && !args.company) context.addIssue({ code: 'custom', message: 'domain or company is required' });
});

mcp.addTool({
  name: 'domain_search',
  annotations: { title: 'Search a domain for emails', readOnlyHint: true, openWorldHint: true },
  description: 'Search Hunter v2 emails for one domain/company with current people, verification, location, job-title, decision-maker, aggregation, and offset filters.',
  parameters: domainSearchSchema,
  execute: async (args) => execute('domain_search', { type: 'domain', identifiers: { domain: args.domain ?? null, company: args.company ?? null } }, async () => {
    const method: Method = args.location ? 'POST' : 'GET';
    const common = {
      ...args,
      seniority: args.seniority?.join(','),
      department: args.department?.join(','),
      required_field: args.required_field?.join(','),
      verification_status: args.verification_status?.join(','),
      job_titles: args.job_titles?.join(','),
    };
    const response = await hunterRequest({
      path: '/domain-search',
      method,
      ...(method === 'GET' ? { query: common } : { body: args }),
      kind: method === 'GET' ? 'read' : 'paid_analysis',
    });
    const emails = arrayData(response.body, ['data', 'emails']);
    const pagination = paginationProof(response.body, emails.length, args.limit, args.offset);
    return reply({
      status: emails.length ? 'succeeded' : 'no_op',
      operation: 'domain_search',
      summary: emails.length ? `Hunter returned ${emails.length} email(s).` : 'Hunter found no emails for the requested company/domain.',
      target: { type: 'domain', identifiers: { domain: response.body.data?.domain ?? args.domain ?? null, company: args.company ?? null } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { pagination, cost: emails.length ? 'search credits depend on returned email count' : 'no query counted for an empty result' },
      warnings: response.body.meta?.results_approximate === true ? ['Hunter meta.results is a lower bound capped at 10,000.'] : [],
    });
  }),
});

const emailFinderSchema = z.object({
  domain: z.string().optional(),
  company: z.string().optional(),
  linkedin_handle: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  max_duration: intInput(3, 20).optional(),
}).strict().superRefine((args, context) => {
  if (!args.domain && !args.company && !args.linkedin_handle) {
    context.addIssue({ code: 'custom', message: 'domain, company, or linkedin_handle is required' });
  }
  if (!args.linkedin_handle && !args.full_name && !(args.first_name && args.last_name)) {
    context.addIssue({ code: 'custom', message: 'full_name or first_name plus last_name is required unless linkedin_handle is provided' });
  }
});

mcp.addTool({
  name: 'email_finder',
  annotations: { title: 'Find an email', readOnlyHint: true, openWorldHint: true },
  description: 'Find and automatically verify the most likely professional email from a company/domain plus name, or directly from a LinkedIn handle.',
  parameters: emailFinderSchema,
  execute: async (args) => execute('email_finder', {
    type: 'person',
    identifiers: {
      domain: args.domain ?? null,
      company: args.company ?? null,
      linkedinHandle: args.linkedin_handle ?? null,
      name: args.full_name ?? ([args.first_name, args.last_name].filter(Boolean).join(' ') || null),
    },
  }, async () => {
    const response = await hunterRequest({ path: '/email-finder', query: args });
    const email = response.body.data?.email ?? null;
    return reply({
      status: email ? 'succeeded' : 'no_op',
      operation: 'email_finder',
      summary: email ? `Hunter found ${email}.` : 'Hunter found no email for the requested person.',
      target: { type: 'person', identifiers: { email, linkedinHandle: args.linkedin_handle ?? null } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { cost: email ? 'one search credit' : 'no credit charged when no email is found', automaticVerification: response.body.data?.verification ?? null },
    });
  }),
});

mcp.addTool({
  name: 'email_verifier',
  annotations: { title: 'Verify an email', readOnlyHint: true, openWorldHint: true },
  description: 'Verify one email address with Hunter v2 and return exact deliverability, score, SMTP/MX, accept-all, webmail, disposable, and source evidence.',
  parameters: z.object({ email: z.string().email() }).strict(),
  execute: async ({ email }) => execute('email_verifier', { type: 'email', identifiers: { email } }, async () => {
    const response = await hunterRequest({ path: '/email-verifier', query: { email } });
    return reply({
      status: 'succeeded',
      operation: 'email_verifier',
      summary: `Hunter verified ${email} as ${response.body.data?.status ?? 'unknown'}.`,
      target: { type: 'email', identifiers: { email } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { cost: 'one verification credit', status: response.body.data?.status ?? null, score: response.body.data?.score ?? null },
    });
  }),
});

mcp.addTool({
  name: 'email_count',
  annotations: { title: 'Count emails for a domain', readOnlyHint: true, openWorldHint: true },
  description: 'Count Hunter email coverage for a domain/company, optionally limited to personal or generic addresses, without returning addresses.',
  parameters: z.object({
    domain: z.string().optional(),
    company: z.string().min(3).optional(),
    type: z.enum(['personal', 'generic']).optional(),
  }).strict().superRefine((args, context) => {
    if (!args.domain && !args.company) context.addIssue({ code: 'custom', message: 'domain or company is required' });
  }),
  execute: async (args) => execute('email_count', { type: 'domain', identifiers: { domain: args.domain ?? null, company: args.company ?? null } }, async () => {
    const response = await hunterRequest({ path: '/email-count', query: args });
    const total = Number(response.body.data?.total ?? 0);
    return reply({
      status: total > 0 ? 'succeeded' : 'no_op',
      operation: 'email_count',
      summary: total > 0 ? `Hunter reports ${total} available email(s).` : 'Hunter reports no available emails.',
      target: { type: 'domain', identifiers: { domain: args.domain ?? null, company: args.company ?? null } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { total, addressDataReturned: false },
    });
  }),
});

const clearbitFormat = z.literal(true).optional().describe('Return Hunter enrichment data in Clearbit-compatible field shape.');

mcp.addTool({
  name: 'email_enrichment',
  annotations: { title: 'Enrich a person', readOnlyHint: true, openWorldHint: true },
  description: 'Enrich a person from an email address or LinkedIn handle using Hunter v2, optionally in Clearbit-compatible format.',
  parameters: z.object({
    email: z.string().email().optional(),
    linkedin_handle: z.string().optional(),
    clearbit_format: clearbitFormat,
  }).strict().superRefine((args, context) => {
    if (!args.email && !args.linkedin_handle) context.addIssue({ code: 'custom', message: 'email or linkedin_handle is required' });
  }),
  execute: async (args) => execute('email_enrichment', { type: 'person', identifiers: { email: args.email ?? null, linkedinHandle: args.linkedin_handle ?? null } }, async () => {
    const response = await hunterRequest({ path: '/people/find', query: args });
    return reply({
      status: 'succeeded', operation: 'email_enrichment',
      summary: 'Hunter returned person enrichment data.',
      target: { type: 'person', identifiers: { email: args.email ?? null, linkedinHandle: args.linkedin_handle ?? null } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { cost: 'one search credit only when Hunter returns the documented core person fields' },
    });
  }),
});

mcp.addTool({
  name: 'company_enrichment',
  annotations: { title: 'Enrich a company', readOnlyHint: true, openWorldHint: true },
  description: 'Enrich a company from its domain using Hunter v2, optionally in Clearbit-compatible format.',
  parameters: z.object({ domain: z.string(), clearbit_format: clearbitFormat }).strict(),
  execute: async (args) => execute('company_enrichment', { type: 'domain', identifiers: { domain: args.domain } }, async () => {
    const response = await hunterRequest({ path: '/companies/find', query: args });
    return reply({
      status: 'succeeded', operation: 'company_enrichment',
      summary: `Hunter returned company enrichment for ${args.domain}.`,
      target: { type: 'domain', identifiers: { domain: args.domain } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { cost: 'one search credit only when Hunter returns the documented core company fields' },
    });
  }),
});

mcp.addTool({
  name: 'combined_enrichment',
  annotations: { title: 'Enrich person and company', readOnlyHint: true, openWorldHint: true },
  description: 'Enrich both a person and their company from one email using Hunter v2, optionally in Clearbit-compatible format.',
  parameters: z.object({ email: z.string().email(), clearbit_format: clearbitFormat }).strict(),
  execute: async (args) => execute('combined_enrichment', { type: 'email', identifiers: { email: args.email } }, async () => {
    const response = await hunterRequest({ path: '/combined/find', query: args });
    return reply({
      status: 'succeeded', operation: 'combined_enrichment',
      summary: `Hunter returned combined enrichment for ${args.email}.`,
      target: { type: 'email', identifiers: { email: args.email } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { cost: 'one search credit only when either documented core person or company data is returned' },
    });
  }),
});

const headcount = z.enum(['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+']);
const companyType = z.enum(['educational', 'educational institution', 'government agency', 'non profit', 'partnership', 'privately held', 'public company', 'self employed', 'self owned', 'sole proprietorship']);
const fundingSeries = z.enum(['pre_seed', 'seed', 'pre_series_a', 'series_a', 'pre_series_b', 'series_b', 'pre_series_c', 'series_c+', 'other']);

const discoverSchema = z.object({
  query: z.string().optional(),
  organization: z.object({ domain: z.array(z.string()).max(100).optional(), name: z.array(z.string()).max(100).optional() }).strict().optional(),
  similar_to: z.object({ domain: z.string().optional(), name: z.string().optional() }).strict().optional(),
  headquarters_location: locationFilter.optional(),
  industry: stringFilter.optional(),
  headcount: z.array(headcount).max(8).optional(),
  company_type: z.object({ include: z.array(companyType).max(10).optional(), exclude: z.array(companyType).max(10).optional() }).strict().optional(),
  year_founded: z.object({
    include: z.array(intInput(1800, 2100)).optional(),
    exclude: z.array(intInput(1800, 2100)).optional(),
    from: intInput(1800, 2100).optional(),
    to: intInput(1800, 2100).optional(),
  }).strict().optional(),
  keywords: matchingStringFilter.optional(),
  technology: matchingStringFilter.optional(),
  funding: z.object({
    series: z.array(fundingSeries).optional(),
    amount: z.object({ from: intInput(0).optional(), to: intInput(0).optional() }).strict().optional(),
    date: z.object({ from: z.string().optional(), to: z.string().optional() }).strict().optional(),
  }).strict().optional(),
  limit: intInput(1, 100).optional(),
  offset: intInput(0, 10_000).optional(),
}).strict().superRefine((args, context) => {
  const filters = { ...args } as Record<string, unknown>;
  delete filters.query;
  delete filters.limit;
  delete filters.offset;
  if (!args.query && !Object.values(filters).some((value) => value !== undefined)) {
    context.addIssue({ code: 'custom', message: 'query or at least one Discover filter is required' });
  }
});

mcp.addTool({
  name: 'discover',
  annotations: { title: 'Discover companies', readOnlyHint: true, openWorldHint: true },
  description: 'Use Hunter Discover v2 to find companies from current natural-language or structured organization, location, industry, headcount, type, year, keyword, technology, and funding filters.',
  parameters: discoverSchema,
  execute: async (args) => execute('discover', { type: 'company_search', identifiers: {} }, async () => {
    const response = await hunterRequest({ path: '/discover', method: 'POST', body: args, kind: 'read' });
    const companies = arrayData(response.body, ['data']);
    const pagination = paginationProof(response.body, companies.length, args.limit, args.offset);
    return reply({
      status: companies.length ? 'succeeded' : 'no_op',
      operation: 'discover',
      summary: companies.length ? `Hunter Discover returned ${companies.length} company result(s).` : 'Hunter Discover found no matching companies.',
      target: { type: 'company_search', identifiers: {} },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { pagination, cost: 'free' },
      warnings: response.body.meta?.filters ? ['Reuse result.meta.filters, not the natural-language query, for stable pagination.'] : [],
    });
  }),
});

const leadFields = {
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  position: z.string().optional(),
  company: z.string().optional(),
  company_industry: z.string().optional(),
  company_size: z.string().optional(),
  confidence_score: intInput(0, 100).optional(),
  website: z.string().optional(),
  country_code: z.string().length(2).optional(),
  linkedin_url: z.string().optional(),
  phone_number: z.string().optional(),
  twitter: z.string().optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
  leads_list_id: intInput(1).optional(),
  leads_list_ids: z.array(intInput(1)).max(100).optional(),
  leads_list_name: z.string().max(255).optional(),
  custom_attributes: z.record(z.string(), z.string()).optional(),
};

mcp.addTool({
  name: 'create_lead',
  annotations: { title: 'Create a lead', readOnlyHint: false, openWorldHint: true },
  description: 'Create one Hunter lead from a required email and optional current lead fields, list placement, and custom attributes. This is a single-attempt mutation.',
  parameters: z.object(leadFields).strict().superRefine((args, context) => {
    if (args.leads_list_name && (args.leads_list_id || args.leads_list_ids?.length)) {
      context.addIssue({ code: 'custom', message: 'leads_list_name cannot be combined with leads_list_id or leads_list_ids' });
    }
  }),
  execute: async (args) => execute('create_lead', { type: 'hunter_lead', identifiers: { email: args.email } }, async () => {
    const response = await hunterRequest({ path: '/leads', method: 'POST', body: args, kind: 'write' });
    const leadId = response.body.data?.id ?? null;
    return reply({
      status: 'succeeded',
      operation: 'create_lead',
      summary: `Hunter acknowledged lead creation${leadId ? ` with ID ${leadId}` : ''}.`,
      target: { type: 'hunter_lead', identifiers: { id: leadId, email: response.body.data?.email ?? args.email } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { apiAcknowledged: true, readBack: false, leadId },
      warnings: ['Hunter acknowledged the write; no independent read-back was performed.'],
      recovery: { nextAction: 'Use list_leads with the exact email before repeating this creation.' },
    });
  }),
});

const leadStatus = z.enum(['clicked', 'opened', 'sent', 'pending', 'error', 'bounced', 'unsubscribed', 'replied', '~']);
const verificationStatus = z.enum(['accept_all', 'disposable', 'invalid', 'unknown', 'valid', 'webmail', 'pending']);
const period = z.string().describe('Hunter period preset, *, ~, or supported date value.');
const dateRange = z.object({ from: z.string().optional(), to: z.string().optional() }).strict();

const listLeadsSchema = z.object({
  leads_list_id: intInput(1).optional(),
  email: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  positions: z.array(z.string()).max(100).optional(),
  company: z.string().optional(),
  industry: z.string().optional(),
  website: z.string().optional(),
  country_code: z.string().length(2).optional(),
  company_size: z.string().optional(),
  source: z.string().optional(),
  twitter: z.string().optional(),
  linkedin_url: z.string().optional(),
  phone_number: z.string().optional(),
  sync_status: z.enum(['pending', 'error', 'success']).optional(),
  sending_statuses: z.array(leadStatus).max(100).optional(),
  verification_statuses: z.array(verificationStatus).max(100).optional(),
  last_activity_at: period.optional(),
  last_contacted_at: period.optional(),
  departments: z.array(z.string()).max(100).optional(),
  tag_ids: z.array(intInput(1)).max(100).optional(),
  campaign_ids: z.array(intInput(1)).max(100).optional(),
  campaign_membership: z.enum(['any', 'none']).optional(),
  user_ids: z.array(intInput(1)).max(100).optional(),
  confidence_score: z.object({ from: intInput(0, 100).optional(), to: intInput(0, 100).optional() }).strict().optional(),
  last_exported_at: period.optional(),
  last_activity_range: dateRange.optional(),
  last_exported_range: dateRange.optional(),
  last_contacted_range: dateRange.optional(),
  created_range: dateRange.optional(),
  updated_range: dateRange.optional(),
  verification_date_range: dateRange.optional(),
  location: z.object({
    country: z.object({ include: z.array(z.string()).max(100).optional(), exclude: z.array(z.string()).max(100).optional() }).strict().optional(),
    state: z.object({ include: z.array(z.string()).max(100).optional(), exclude: z.array(z.string()).max(100).optional() }).strict().optional(),
    city: z.object({ include: z.array(z.string()).max(100).optional(), exclude: z.array(z.string()).max(100).optional() }).strict().optional(),
    continent: z.object({ include: z.array(z.string()).max(100).optional(), exclude: z.array(z.string()).max(100).optional() }).strict().optional(),
    business_region: z.object({ include: z.array(z.enum(['AMER', 'EMEA', 'APAC', 'LATAM'])).max(100).optional(), exclude: z.array(z.enum(['AMER', 'EMEA', 'APAC', 'LATAM'])).max(100).optional() }).strict().optional(),
  }).strict().optional(),
  custom_attributes: z.record(z.string(), z.string()).optional(),
  query: z.string().optional(),
  limit: intInput(1, 1_000).optional(),
  offset: intInput(0, 100_000).optional(),
}).strict().superRefine((args, context) => {
  if (args.campaign_ids?.length && args.campaign_membership) {
    context.addIssue({ code: 'custom', message: 'campaign_ids and campaign_membership are mutually exclusive' });
  }
});

function leadListQuery(args: z.infer<typeof listLeadsSchema>): Record<string, unknown> {
  const query: Record<string, unknown> = {
    leads_list_id: args.leads_list_id,
    email: args.email,
    first_name: args.first_name,
    last_name: args.last_name,
    'position[]': args.positions,
    company: args.company,
    industry: args.industry,
    website: args.website,
    country_code: args.country_code,
    company_size: args.company_size,
    source: args.source,
    twitter: args.twitter,
    linkedin_url: args.linkedin_url,
    phone_number: args.phone_number,
    sync_status: args.sync_status,
    'sending_status[]': args.sending_statuses,
    'verification_status[]': args.verification_statuses,
    last_activity_at: args.last_activity_at,
    last_contacted_at: args.last_contacted_at,
    'department[]': args.departments,
    'tags[]': args.tag_ids,
    'campaign_ids[]': args.campaign_ids,
    campaign_ids: args.campaign_membership === 'any' ? '*' : args.campaign_membership === 'none' ? '~' : undefined,
    'user_id[]': args.user_ids,
    'confidence_score[from]': args.confidence_score?.from,
    'confidence_score[to]': args.confidence_score?.to,
    last_exported_at: args.last_exported_at,
    query: args.query,
    limit: args.limit,
    offset: args.offset,
  };
  const ranges: Array<[string, { from?: string; to?: string } | undefined]> = [
    ['last_activity_at', args.last_activity_range],
    ['last_exported_at', args.last_exported_range],
    ['last_contacted_at', args.last_contacted_range],
    ['created_at', args.created_range],
    ['updated_at', args.updated_range],
    ['verification_date', args.verification_date_range],
  ];
  for (const [name, range] of ranges) {
    query[`${name}[from]`] = range?.from;
    query[`${name}[to]`] = range?.to;
  }
  for (const [dimension, values] of Object.entries(args.location ?? {}) as Array<[string, { include?: string[]; exclude?: string[] }]>) {
    query[`location[${dimension}][include][]`] = values.include;
    query[`location[${dimension}][exclude][]`] = values.exclude;
  }
  for (const [slug, value] of Object.entries(args.custom_attributes ?? {})) {
    query[`custom_attributes[${slug}]`] = value;
  }
  return query;
}

mcp.addTool({
  name: 'list_leads',
  annotations: { title: 'List leads', readOnlyHint: true, openWorldHint: true },
  description: 'List Hunter leads with current list, identity, company, status, verification, activity/date, location, tag, campaign, user, confidence, custom-attribute, query, and offset filters.',
  parameters: listLeadsSchema,
  execute: async (args) => execute('list_leads', { type: 'hunter_lead_collection', identifiers: { listId: args.leads_list_id ?? null } }, async () => {
    const response = await hunterRequest({ path: '/leads', query: leadListQuery(args) });
    const leads = arrayData(response.body, ['data', 'leads']);
    const pagination = paginationProof(response.body, leads.length, args.limit, args.offset);
    return reply({
      status: leads.length ? 'succeeded' : 'no_op',
      operation: 'list_leads',
      summary: leads.length ? `Hunter returned ${leads.length} lead(s).` : 'Hunter found no leads matching the filters.',
      target: { type: 'hunter_lead_collection', identifiers: { listId: args.leads_list_id ?? null } },
      result: { data: response.body, _meta: apiMeta(response) },
      proof: { pagination },
    });
  }),
});

mcp.start({ transportType: 'stdio' });
