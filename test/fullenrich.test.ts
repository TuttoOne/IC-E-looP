import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FullEnrichClient } from '../src/fullenrich/client.js';

function jsonResponse(json: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => json } as Response;
}

describe('FullEnrichClient.enrich', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts a bulk enrichment then returns normalized emails/phones once FINISHED', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ enrichment_id: 'abc' }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'FINISHED',
          datas: [
            {
              contact_info: {
                most_probable_work_email: 'jane@acme.com',
                work_emails: [],
                most_probable_phone: '+33612345678',
                phones: [],
              },
            },
          ],
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FullEnrichClient('test-key');
    const promise = client.enrich({ linkedinUrl: 'https://linkedin.com/in/jane' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.workEmails).toEqual(['jane@acme.com']);
    expect(result.phones).toEqual(['+33612345678']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on an invalid API key (401)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'invalid' }, 401)));
    const client = new FullEnrichClient('bad-key');
    await expect(client.enrich({ linkedinUrl: 'https://linkedin.com/in/jane' })).rejects.toThrow(/clé API invalide/);
  });
});
