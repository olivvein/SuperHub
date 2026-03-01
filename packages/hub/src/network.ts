import ipaddr from "ipaddr.js";

export function normalizeClientIp(ip: string): string | null {
  let value = ip.split(",")[0]?.trim() ?? "";
  if (!value) {
    return null;
  }

  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  }

  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }

  value = value.replace(/^::ffff:/, "");
  if (value.includes("%")) {
    value = value.slice(0, value.indexOf("%"));
  }

  return value || null;
}

export function isIpAllowlisted(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0 || allowlist.includes("*")) {
    return true;
  }

  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) {
    return false;
  }

  let parsedIp: ReturnType<typeof ipaddr.parse>;

  try {
    parsedIp = ipaddr.parse(normalizedIp);
  } catch {
    return false;
  }

  for (const entry of allowlist) {
    const normalizedEntry = entry.replace(/^::ffff:/, "");
    try {
      const candidateIp =
        parsedIp.kind() === "ipv6" &&
        "isIPv4MappedAddress" in parsedIp &&
        typeof parsedIp.isIPv4MappedAddress === "function" &&
        parsedIp.isIPv4MappedAddress()
          ? parsedIp.toIPv4Address()
          : parsedIp;

      if (normalizedEntry.includes("/")) {
        const range = ipaddr.parseCIDR(normalizedEntry);
        const networkAddress = range[0];
        const prefix = range[1];
        if (candidateIp.kind() !== networkAddress.kind()) {
          continue;
        }
        if (candidateIp.match([networkAddress, prefix])) {
          return true;
        }
      } else if (candidateIp.toString() === ipaddr.parse(normalizedEntry).toString()) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}
