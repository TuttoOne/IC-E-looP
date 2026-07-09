import { describe, it, expect, vi, afterEach } from 'vitest';
import { TsplusCrmClient } from '../src/crm/client.js';
import { pushQualifiedLead, SOURCE_LIST } from '../src/crm/pipeline.js';

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/** Route les appels fetch par méthode + chemin ; enregistre les corps POST pour assertions. */
function mockBackend(handlers: Record<string, (url: URL, init: RequestInit) => Response>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      path: url.pathname,
      body: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body,
    });
    const key = `${method} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected call ${key}`);
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

const client = () =>
  new TsplusCrmClient({ baseUrl: 'http://crm.test', username: 'svc', password: 'pw' });

const lead = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@acme.com',
  phone: '+33612345678',
  jobTitle: 'Head of Sales',
  linkedinUrl: 'https://linkedin.com/in/jane',
  companyName: 'Acme',
  sourceSignal: 'new CRO, 3 weeks in',
};

describe('pushQualifiedLead', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('logs in, dedups by email, then creates a prospect when none exists', async () => {
    const { calls } = mockBackend({
      'POST /api/auth/login': () => json({ access_token: 't0k', token_type: 'bearer' }),
      'GET /api/prospects': () => json([]), // pas de match
      'POST /api/prospects': (_u, init) => json({ id: 42, email: JSON.parse(init.body as string).email }, 201),
    });

    const res = await pushQualifiedLead(client(), lead);

    expect(res).toEqual({ prospectId: 42, created: true, enrolled: false });
    const create = calls.find((c) => c.method === 'POST' && c.path === '/api/prospects');
    expect(create!.body).toMatchObject({
      email: 'jane@acme.com',
      first_name: 'Jane',
      title: 'Head of Sales',
      company: 'Acme',
      source_list: SOURCE_LIST,
      status: 'new',
    });
    // téléphone (pas de champ dédié) et signal source rangés dans notes
    expect(create!.body.notes).toContain('new CRO, 3 weeks in');
    expect(create!.body.notes).toContain('+33612345678');
  });

  it('reuses an existing prospect (exact email match) without creating a duplicate', async () => {
    const { calls } = mockBackend({
      'POST /api/auth/login': () => json({ access_token: 't0k' }),
      'GET /api/prospects': () => json({ items: [{ id: 7, email: 'JANE@acme.com' }] }),
    });

    const res = await pushQualifiedLead(client(), lead);

    expect(res).toEqual({ prospectId: 7, created: false, enrolled: false });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/prospects')).toBe(false);
  });

  it('enrolls the prospect when a sequenceId is provided', async () => {
    const { calls } = mockBackend({
      'POST /api/auth/login': () => json({ access_token: 't0k' }),
      'GET /api/prospects': () => json([]),
      'POST /api/prospects': () => json({ id: 99 }, 201),
      'POST /api/sequences/5/enroll': () => json({ enrolled: 1 }),
    });

    const res = await pushQualifiedLead(client(), lead, { sequenceId: 5 });

    expect(res.enrolled).toBe(true);
    const enroll = calls.find((c) => c.path === '/api/sequences/5/enroll');
    expect(enroll!.body).toEqual({ prospect_ids: [99], send_mode: 'manual' });
  });

  // Le backend expose aujourd'hui GET /api/prospects mais pas POST -> 405 (Method Not Allowed).
  it.each([405, 404])('surfaces a clear error if the create endpoint is missing (%i)', async (status) => {
    mockBackend({
      'POST /api/auth/login': () => json({ access_token: 't0k' }),
      'GET /api/prospects': () => json([]),
      'POST /api/prospects': () => json({ detail: 'Method Not Allowed' }, status),
    });

    await expect(pushQualifiedLead(client(), lead)).rejects.toThrow(/POST \/api\/prospects indisponible/);
  });
});
