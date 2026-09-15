import { describe, expect, it } from "vitest";
import { DnsmasqLeaseProvider } from "./dhcp.js";

const providerFor = (contents: string) =>
  new DnsmasqLeaseProvider({
    leaseFilePath: "/leases/dnsmasq.leases",
    vlanId: 999,
    readLeaseFile: async () => contents,
  });

describe("DnsmasqLeaseProvider", () => {
  it("looks up normalized leases by IP and MAC", async () => {
    const provider = providerFor(
      "1893456000 aa:bb:cc:dd:ee:ff 10.99.0.42 pit-laptop 01:aa\n",
    );

    await expect(provider.getLeaseByIp("10.99.0.42")).resolves.toEqual({
      ip: "10.99.0.42",
      mac: "AA:BB:CC:DD:EE:FF",
      vlanId: 999,
      hostname: "pit-laptop",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await expect(
      provider.getLeaseByMac("aa-bb-cc-dd-ee-ff"),
    ).resolves.toMatchObject({ ip: "10.99.0.42" });
  });

  it("supports infinite leases and omits dnsmasq placeholder hostnames", async () => {
    const provider = providerFor("0 02:00:00:00:00:01 10.99.0.50 * 01:02\n");

    await expect(provider.getLeaseByIp("10.99.0.50")).resolves.toEqual({
      ip: "10.99.0.50",
      mac: "02:00:00:00:00:01",
      vlanId: 999,
    });
  });

  it("ignores malformed records and lets the newest duplicate win", async () => {
    const provider = providerFor(
      [
        "not-a-lease",
        "1893456000 invalid 10.99.0.40 host id",
        "1893456000 aa:bb:cc:dd:ee:ff 10.99.0.41 old id",
        "1893456001 aa:bb:cc:dd:ee:ff 10.99.0.42 new id",
      ].join("\n"),
    );

    await expect(provider.getLeaseByIp("10.99.0.41")).resolves.toBeNull();
    await expect(provider.getLeaseByIp("10.99.0.42")).resolves.toMatchObject({
      hostname: "new",
    });
  });

  it("treats a not-yet-created lease file as empty", async () => {
    const provider = new DnsmasqLeaseProvider({
      leaseFilePath: "/missing",
      readLeaseFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });

    await expect(provider.getLeaseByIp("10.99.0.1")).resolves.toBeNull();
  });
});
