import type { DhcpLease, DhcpLeaseProvider } from "@repo/core";

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
