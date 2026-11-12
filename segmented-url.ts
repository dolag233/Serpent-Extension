/** Public HTTP(S) media resources only; loopback, local and private address literals are rejected. */
export function isSafeRemoteMediaUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  const address = host.replace(/^\[|\]$/gu, '');
  if (address.includes(':')) return !isBlockedIpv6(address);
  const ipv4 = parseIpv4(address);
  return ipv4 ? !isBlockedIpv4(ipv4) : true;
}

export function resolveSafeMediaResourceUrl(reference: string, base: string): string {
  let resolved: URL;
  try { resolved = new URL(reference, base); } catch { throw new Error('invalid-media-url'); }
  const value = resolved.toString();
  if (!isSafeRemoteMediaUrl(value)) throw new Error('unsafe-media-url');
  return value;
}

/** Stable identity for comparing a refreshed signed URL with the same media path. */
export function stableMediaResourceIdentity(value: string): string {
  const url = new URL(value);
  url.hash = '';
  const retained: Array<[string, string]> = [];
  for (const [key, item] of url.searchParams) {
    if (!/^(?:auth|auth[_-]?(?:key|token)|authkey|token|access[_-]?token|signature|sig|sign|expires?|expiry|exp|policy|key-pair-id|jwt|hdnts|hdntl|wssecret|wstime|__gda__|x-amz-.+|x-goog-.+|x-oss-.+|x-cos-.+|e)$/iu.test(key)) {
      retained.push([key, item]);
    }
  }
  retained.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = '';
  for (const [key, item] of retained) url.searchParams.append(key, item);
  return url.toString();
}

function parseIpv4(value: string): [number, number, number, number] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (!octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return undefined;
  return octets as [number, number, number, number];
}

function isBlockedIpv4([a, b, c]: [number, number, number, number]): boolean {
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isBlockedIpv6(value: string): boolean {
  const groups = parseIpv6(value);
  if (!groups) return true;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && eighth === 1) return true;
  if ((first! & 0xfe00) === 0xfc00) return true; // Unique local fc00::/7.
  if ((first! & 0xffc0) === 0xfe80) return true; // Link local fe80::/10.
  if ((first! & 0xffc0) === 0xfec0) return true; // Deprecated site local fec0::/10.
  if ((first! & 0xff00) === 0xff00) return true; // Multicast is not a remote media origin.

  const mappedPrefix = [first, second, third, fourth, fifth];
  if (mappedPrefix.every((group) => group === 0) && sixth === 0xffff) {
    const mapped = [seventh! >>> 8, seventh! & 0xff, eighth! >>> 8, eighth! & 0xff] as [number, number, number, number];
    return isBlockedIpv4(mapped);
  }
  // IPv4-compatible ::/96 addresses are deprecated and must not bypass IPv4 filtering.
  if (groups.slice(0, 6).every((group) => group === 0)) {
    const compatible = [seventh! >>> 8, seventh! & 0xff, eighth! >>> 8, eighth! & 0xff] as [number, number, number, number];
    return isBlockedIpv4(compatible) || compatible[0] === 0;
  }
  return false;
}

function parseIpv6(value: string): number[] | undefined {
  if (!value || value.includes('%') || value.includes(':::')) return undefined;
  let expanded = value;
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    if (lastColon < 0) return undefined;
    const ipv4 = parseIpv4(expanded.slice(lastColon + 1));
    if (!ipv4) return undefined;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    expanded = `${expanded.slice(0, lastColon)}:${high}:${low}`;
  }

  const compressionIndex = expanded.indexOf('::');
  if (compressionIndex >= 0 && expanded.indexOf('::', compressionIndex + 2) >= 0) return undefined;
  const leftText = compressionIndex < 0 ? expanded : expanded.slice(0, compressionIndex);
  const rightText = compressionIndex < 0 ? '' : expanded.slice(compressionIndex + 2);
  const left = parseIpv6Groups(leftText);
  const right = parseIpv6Groups(rightText);
  if (!left || !right) return undefined;
  if (compressionIndex < 0) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Groups(value: string): number[] | undefined {
  if (!value) return [];
  const groups = value.split(':');
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}
