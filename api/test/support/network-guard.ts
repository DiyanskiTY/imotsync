import net from 'node:net';
import { afterEach } from 'vitest';

/*
 * Test-wide guard (setupFiles of both Vitest configurations): no test may open a connection
 * to a host other than this machine, so no test can ever reach a real portal (realistimo.com,
 * bazar.bg) or any other outside service, whatever the developer's .env says.
 *
 * Every TCP connection in Node (http, https, fetch, the database driver) goes through
 * net.Socket.prototype.connect, so the guard wraps it: a connection to anything but a loopback
 * address or "localhost" throws at once, and the test that tried fails in afterEach even when
 * the code under test caught the error (e.g. a client turning it into a retryable failure).
 * Child processes (the spawned `worker --once`) get REALISTIMO_API_KEY='' and a dead local
 * REALISTIMO_API_BASE_URL explicitly instead.
 */

const LOCAL_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']);

export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined || host === '') return true; // Node's default is localhost.
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    LOCAL_HOSTS.has(name) ||
    name.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) ||
    name === '0.0.0.0'
  );
}

/** The host a Socket#connect call is about, or null for a local (IPC) path. */
function targetHost(args: unknown[]): string | null | undefined {
  // net.connect() passes its normalised arguments as one array.
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first !== null && typeof first === 'object') {
    const options = first as { host?: string; path?: string };
    if (typeof options.path === 'string') return null;
    return options.host;
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; // An IPC path.
  const host: unknown = Array.isArray(args[0]) ? undefined : args[1];
  return typeof host === 'string' ? host : undefined;
}

const blocked: string[] = [];
const GUARDED = Symbol.for('imotsync.networkGuard');
type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;
const proto = net.Socket.prototype as unknown as Record<symbol, boolean> & { connect: Connect };

if (!proto[GUARDED]) {
  const original = proto.connect;
  proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const host = targetHost(args);
    if (host !== null && !isLocalHost(host)) {
      const message = `Tests must not connect to ${host}: only local hosts are allowed (test/support/network-guard.ts)`;
      blocked.push(message);
      throw new Error(message);
    }
    return original.apply(this, args);
  };
  proto[GUARDED] = true;
}

/** The blocked attempts so far, cleared (for the guard's own tests). */
export function takeBlockedConnections(): string[] {
  return blocked.splice(0);
}

afterEach(() => {
  if (blocked.length === 0) return;
  const messages = blocked.splice(0);
  throw new Error(`Outbound network access in this test:\n${messages.join('\n')}`);
});
