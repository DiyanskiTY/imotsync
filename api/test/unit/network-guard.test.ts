import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isLocalHost, takeBlockedConnections } from '../support/network-guard.js';

describe('the test-wide network guard', () => {
  it('blocks fetch to a remote host before any connection is made', async () => {
    await expect(
      fetch('https://portal.example/rest-api/import/start', { method: 'POST' }),
    ).rejects.toThrow();

    expect(takeBlockedConnections()).toEqual([
      expect.stringContaining('Tests must not connect to portal.example'),
    ]);
  });

  it('blocks a plain TCP connection to a remote address', () => {
    expect(() => net.connect({ host: '203.0.113.7', port: 443 })).toThrow(/must not connect/);
    expect(() => net.connect(80, 'portal.example')).toThrow(/must not connect/);

    expect(takeBlockedConnections()).toHaveLength(2);
  });

  it('lets connections to this machine through', async () => {
    const server = createServer((_req, res) => res.end('local'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('local');
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('local');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(takeBlockedConnections()).toEqual([]);
  });

  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['[::1]', true],
    ['app.localhost', true],
    [undefined, true],
    ['realistimo.com', false],
    ['bazar.bg', false],
    ['10.0.0.5', false],
    ['127.0.0.1.example', false],
  ])('treats %s as local: %s', (host, local) => {
    expect(isLocalHost(host)).toBe(local);
  });
});
