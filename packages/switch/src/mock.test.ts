import { describe, expect, it } from "vitest";
import { MockManagedSwitch } from "./mock.js";

describe("MockManagedSwitch", () => {
  it("creates configurable ports and supports VLAN/MAC learning", async () => {
    const sw = new MockManagedSwitch({ portCount: 3, onboardingVlan: 999 });
    expect((await sw.getPorts()).map((port) => port.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect((await sw.getPort("1")).accessVlan).toBe(999);
    await sw.setAccessVlan("1", 30);
    sw.learnMac("aa:bb:cc:dd:ee:ff", "1");
    expect(await sw.findPortByMac("AA-BB-CC-DD-EE-FF")).toBe("1");
    expect((await sw.getMacsOnPort("1"))[0]?.vlanId).toBe(30);
  });

  it("simulates link state, bounce, availability, and failures", async () => {
    const sw = new MockManagedSwitch({ bounceDelayMs: 0 });
    sw.simulateLink("1", true);
    await sw.bouncePort("1");
    expect((await sw.getPort("1")).linkUp).toBe(true);
    sw.setAvailable(false);
    await expect(sw.getPorts()).rejects.toThrow("unavailable");
    sw.setAvailable(true);
    sw.setOperationFailure("getPorts", new Error("simulated timeout"));
    await expect(sw.getPorts()).rejects.toThrow("simulated timeout");
  });

  it("flushes learned entries when a port VLAN changes", async () => {
    const sw = new MockManagedSwitch({ onboardingVlan: 999 });
    sw.learnMac("aa:bb:cc:dd:ee:ff", "1");
    await sw.setAccessVlan("1", 30);
    expect(await sw.getMacTable()).toEqual([]);
  });
});
