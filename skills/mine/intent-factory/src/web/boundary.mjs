/**
 * The dashboard's network boundary: the decisions that must be settled before
 * a socket exists. `server.mjs` serves routes; this module decides whether it
 * may listen at all — which address the bind host resolves to, whether that
 * address is private (loopback, RFC1918, or the 100.64.0.0/10 CGNAT range
 * Tailscale assigns), and the bearer token file that is the second lock behind
 * the private network. The address ranges decide, never the Tailscale binary:
 * a literal classifies identically with or without the daemon, so nothing here
 * shells out or resolves anything beyond the local resolver.
 */
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import { errorMessage, fail } from "../util.mjs";

/** The admissible bind space: loopback, RFC1918 and CGNAT — the range Tailscale hands out. Everything else, wildcard or public, is refused. */
const PRIVATE_BIND = new net.BlockList();
PRIVATE_BIND.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_BIND.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_BIND.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_BIND.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_BIND.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_BIND.addSubnet("::1", 128, "ipv6");

const BIND_HELP = "bind loopback, an RFC1918 address, or a 100.64.0.0/10 CGNAT address (the Tailscale range)";

/**
 * The address a bind host stands for: IP literals pass through untouched, and
 * a name resolves through the host resolver (which reads /etc/hosts) with its
 * first result standing in for the set.
 *
 * @param {string} host
 * @returns {Promise<string>}
 */
export async function resolveBindAddress(host) {
  if (net.isIP(host) !== 0) return host;
  try {
    return (await lookup(host)).address;
  } catch (error) {
    throw fail("bind_unresolvable", `cannot resolve bind host ${host}: ${errorMessage(error)}`);
  }
}

/** An IPv6 form like `::ffff:203.0.113.10` classifies by the IPv4 address it carries. @param {string} address @returns {string} */
function unwrapIPv4Mapped(address) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return mapped ? mapped[1] : address;
}

/**
 * Passes when the address is private and returns the canonical address to
 * bind; throws with the reason when it is a wildcard or public. Callers run
 * this before `listen`: binding and closing again still exposed the port for
 * the time it was open.
 *
 * @param {string} address
 * @returns {string}
 */
export function assertPrivateBind(address) {
  if (address === "0.0.0.0") throw fail("public_bind", `refusing to bind 0.0.0.0: the IPv4 wildcard accepts connections on every interface, the public ones included; ${BIND_HELP}`);
  if (address === "::") throw fail("public_bind", `refusing to bind '::': the IPv6 wildcard accepts connections on every interface, the public ones included; ${BIND_HELP}`);
  const plain = unwrapIPv4Mapped(address);
  // The family must be stated: without it, BlockList.check misses IPv6 rules (measured on Node 26.8.1).
  const family = net.isIPv4(plain) ? "ipv4" : "ipv6";
  if (PRIVATE_BIND.check(plain, family)) return plain;
  throw fail("public_bind", `refusing to bind ${address}: not a private address; ${BIND_HELP}`);
}

/**
 * The bearer token from a local file — the second lock behind the private
 * network; there is no login system. One trimmed, space-free line, and the
 * value never appears in any message this module produces.
 *
 * @param {string} path
 * @returns {string}
 */
export function loadBearerToken(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw fail("token_unreadable", `bearer token file is missing or unreadable: ${path} (${errorMessage(error)})`);
  }
  const token = raw.trim();
  if (!token) throw fail("token_empty", `bearer token file is empty: ${path}`);
  if (/\s/u.test(token)) throw fail("token_invalid", `bearer token file must hold a single space-free line: ${path}`);
  return token;
}
