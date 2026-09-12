import { describe, expect, it } from "vitest";
import { MockAccessPoint } from "./mock.js";

describe("MockAccessPoint", () => {
  it("provides six configurable slots and association status", async () => {
    const ap = new MockAccessPoint();
    const { slotIds } = await ap.getCapabilities();
    expect(slotIds).toHaveLength(6);
    const slot = slotIds[0]!;
    await ap.configureTeam(slot, {
      teamNumber: 5712,
      ssid: "FRC-5712",
      vlanId: 30,
    });
    expect((await ap.getStationStatus(slot)).state).toBe("configured");
    ap.simulateAssociation(slot, {
      macAddress: "aa:bb:cc:dd:ee:ff",
      signalStrengthDbm: -48,
    });
    expect((await ap.getStationStatus(slot)).state).toBe("associated");
    expect((await ap.getStations())[0]?.teamNumber).toBe(5712);
    await ap.clearTeam(slot);
    expect((await ap.getStationStatus(slot)).state).toBe("available");
  });
});
