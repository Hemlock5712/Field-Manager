import type { DhcpLease, DhcpLeaseProvider } from "@repo/core";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

const normalizeMac = (mac: string): string =>
  mac.trim().toUpperCase().replaceAll("-", ":");

export class MockDhcpLeaseProvider implements DhcpLeaseProvider {
  private readonly byIp = new Map<string, DhcpLease>();
  private readonly byMac = new Map<string, DhcpLease>();

  constructor(leases: DhcpLease[] = []) {
    for (const lease of leases) this.setLease(lease);
  }

  async getLeaseByIp(ip: string): Promise<DhcpLease | null> {
    return this.byIp.get(ip) ?? null;
  }
  async getLeaseByMac(mac: string): Promise<DhcpLease | null> {
    return this.byMac.get(normalizeMac(mac)) ?? null;
  }

  setLease(lease: DhcpLease): void {
    const normalized = { ...lease, mac: normalizeMac(lease.mac) };
    const previous = this.byIp.get(lease.ip);
    if (previous) this.byMac.delete(normalizeMac(previous.mac));
    this.byIp.set(lease.ip, normalized);
    this.byMac.set(normalized.mac, normalized);
  }

  removeLeaseByIp(ip: string): void {
    const lease = this.byIp.get(ip);
    if (lease) this.byMac.delete(normalizeMac(lease.mac));
    this.byIp.delete(ip);
  }

  listLeases(): DhcpLease[] {
    return [...this.byIp.values()].map((lease) => ({ ...lease }));
  }
}

export interface DnsmasqLeaseProviderOptions {
  leaseFilePath: string;
  vlanId?: number;
  readLeaseFile?: (path: string) => Promise<string>;
}

/** Read-only adapter for dnsmasq's `<expiry> <mac> <ip> <host> <id>` lease file. */
export class DnsmasqLeaseProvider implements DhcpLeaseProvider {
  private readonly leaseFilePath: string;
  private readonly vlanId?: number;
  private readonly readLeaseFile: (path: string) => Promise<string>;

  constructor(options: DnsmasqLeaseProviderOptions) {
    if (!options.leaseFilePath.trim())
      throw new TypeError("dnsmasq leaseFilePath is required");
    this.leaseFilePath = options.leaseFilePath;
    this.vlanId = options.vlanId;
    this.readLeaseFile =
      options.readLeaseFile ??
      (async (path) => readFile(path, { encoding: "utf8" }));
  }

  async getLeaseByIp(ip: string): Promise<DhcpLease | null> {
    return (await this.readLeases()).find((lease) => lease.ip === ip) ?? null;
  }

  async getLeaseByMac(mac: string): Promise<DhcpLease | null> {
    const normalized = normalizeMac(mac);
    return (
      (await this.readLeases()).find((lease) => lease.mac === normalized) ??
      null
    );
  }

  private async readLeases(): Promise<DhcpLease[]> {
    let contents: string;
    try {
      contents = await this.readLeaseFile(this.leaseFilePath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return [];
      throw error;
    }

    const byIp = new Map<string, DhcpLease>();
    const byMac = new Map<string, DhcpLease>();
    for (const line of contents.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4) continue;
      const [expiresText, rawMac, ip, rawHostname] = fields;
      if (!expiresText || !rawMac || !ip || !rawHostname || !isIP(ip)) continue;
      const expiresSeconds = Number(expiresText);
      if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 0) continue;
      const mac = normalizeMac(rawMac);
      if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac)) continue;
      const lease: DhcpLease = {
        ip,
        mac,
        ...(this.vlanId === undefined ? {} : { vlanId: this.vlanId }),
        ...(rawHostname === "*" || rawHostname === "-"
          ? {}
          : { hostname: rawHostname }),
        ...(expiresSeconds === 0
          ? {}
          : { expiresAt: new Date(expiresSeconds * 1000).toISOString() }),
      };
      const previousForIp = byIp.get(ip);
      if (previousForIp) byMac.delete(previousForIp.mac);
      const previousForMac = byMac.get(mac);
      if (previousForMac) byIp.delete(previousForMac.ip);
      byIp.set(ip, lease);
      byMac.set(mac, lease);
    }
    return [...byIp.values()];
  }
}
