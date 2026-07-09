import { describe, it, expect, vi, afterEach } from 'vitest';
import { HubspotClient, businessDomain } from '../src/hubspot/client.js';

function jsonResponse(json: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => json } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('businessDomain', () => {
  it('extracts a business domain and ignores free mail providers', () => {
    expect(businessDomain('jane@acme.com')).toBe('acme.com');
    expect(businessDomain('jane@gmail.com')).toBeNull();
  });
});

describe('HubspotClient.lookupContactByEmail', () => {
  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(null, 404)));
    const client = new HubspotClient('token');
    expect(await client.lookupContactByEmail('jane@acme.com')).toBeNull();
  });

  it('returns the contact id on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: '42' })));
    const client = new HubspotClient('token');
    expect(await client.lookupContactByEmail('jane@acme.com')).toEqual({ id: '42' });
  });
});

describe('HubspotClient.upsertContact', () => {
  it('resolves the existing id on a 409 conflict, like the extension does', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, 404)) // lookupContactByEmail
      .mockResolvedValueOnce(jsonResponse({ message: 'Existing ID: 99' }, 409)) // create -> conflict
      .mockResolvedValueOnce(jsonResponse({ id: '99' })); // patch
    vi.stubGlobal('fetch', fetchMock);

    const client = new HubspotClient('token');
    const result = await client.upsertContact({ email: 'jane@acme.com' });

    expect(result).toEqual({ id: '99', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('HubspotClient.findDealPipelineStage', () => {
  it('resolves pipeline and stage ids by their labels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [{ id: 'p1', label: '1POINT6 Sales Pipeline', stages: [{ id: 's1', label: 'Discovery' }] }],
        })
      )
    );
    const client = new HubspotClient('token');
    expect(await client.findDealPipelineStage('1POINT6 Sales Pipeline', 'Discovery')).toEqual({
      pipelineId: 'p1',
      stageId: 's1',
    });
  });

  it('throws when the pipeline label is not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ results: [] })));
    const client = new HubspotClient('token');
    await expect(client.findDealPipelineStage('Unknown Pipeline', 'Discovery')).rejects.toThrow(/introuvable/);
  });
});
