import { isIP } from "node:net";

/**
 * Validate URL-shaped provider API metadata consistently for live catalog
 * normalization, normalized catalog cache reads, and provider cache reads.
 * Non-URL placeholders such as ${ENV_VAR}/v1 remain metadata, not endpoints.
 */
export function isSafeProviderApiUrl(value: string, isCredentialQueryKey: (key: string) => boolean): boolean {
  if (value !== value.trim()) return false;
  if (!/^https?:\/\//i.test(value)) return !/^[a-z][a-z0-9+.-]*:/i.test(value);
  try {
    const parsed = new URL(value);
    const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/u, 1)[0] ?? "";
    const loopbackHttp = parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
    return parsed.hostname !== ""
      && (parsed.protocol === "https:" || loopbackHttp)
      && !authority.includes("@")
      && !parsed.username
      && !parsed.password
      && (!isPrivateHost(parsed.hostname) || loopbackHttp)
      && [...parsed.searchParams.keys()].every((key) => !isCredentialQueryKey(key));
  } catch {
    return false;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/u, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || isExpandedIpv6Loopback(host)) return true;
  const mapped = ipv4MappedHost(host);
  if (mapped) return isLoopbackHost(mapped);
  return isIP(host) === 4 && host.split(".")[0] === "127";
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/u, "");
  if (isLoopbackHost(host)) return true;
  const mapped = ipv4MappedHost(host);
  if (mapped) return isPrivateHost(mapped);
  if (isIP(host) === 6) {
    const firstHex = Number.parseInt(host.slice(0, 4), 16);
    return host === "::"
      || host.startsWith("fc")
      || host.startsWith("fd")
      || host.startsWith("ff")
      || (firstHex >= 0xfe80 && firstHex <= 0xfebf);
  }
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

function isExpandedIpv6Loopback(host: string): boolean {
  if (isIP(host) !== 6 || !host.includes(":")) return false;
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return false;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return false;
  return groups.slice(0, 7).every((group) => Number.parseInt(group, 16) === 0) && Number.parseInt(groups[7], 16) === 1;
}

function ipv4MappedHost(host: string): string | undefined {
  if (!host.startsWith("::ffff:")) return undefined;
  const tail = host.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}
