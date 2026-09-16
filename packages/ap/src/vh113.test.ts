import { describe, expect, it } from "vitest";
import {
  AccessPointOperationError,
  AccessPointSlotNotFoundError,
} from "./index.js";
import { VH113AccessPoint } from "./vh113.js";

const slots = ["red1", "red2", "red3", "blue1", "blue2", "blue3"];

function status(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    channel: 93,
    channelBandwidth: "20MHz",
    redVlans: "10_20_30",
    blueVlans: "40_50_60",
    status: "ACTIVE",
    stationStatuses: Object.fromEntries(slots.map((slot) => [slot, null])),
    syslogIpAddress: "",
    version: "1.2.3",
    ...overrides,
  };
}

function fakeApi(initial = status()) {
  let current = structuredClone(initial);
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/status")
      return new Response(JSON.stringify(current), { status: 200 });
    if (path === "/configuration" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ path, body });
      const practiceFirmware = String(current.version).includes(
        "_AP_PRACTICE_",
      );
      const stationConfigurations = body.stationConfigurations as Record<
        string,
        { ssid: string }
      >;
      current = status({
        redVlans: body.redVlans,
        blueVlans: body.blueVlans,
        stationStatuses: Object.fromEntries(
          slots.map((slot) => [
            slot,
            stationConfigurations[slot]
              ? {
                  ...stationConfigurations[slot],
                  hashedWpaKey: "",
                  wpaKeySalt: "",
                  isLinked: false,
                  macAddress: "",
                  signalDbm: 0,
                }
              : practiceFirmware
                ? {
                    ssid: String(slots.indexOf(slot) + 1),
                    hashedWpaKey: `hash-${slot}`,
                    wpaKeySalt: `salt-${slot}`,
                    isLinked: false,
                    macAddress: "",
                    signalDbm: 0,
                  }
                : null,
          ]),
        ),
        version: current.version,
      });
      return new Response("accepted", { status: 202 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests, getStatus: () => current };
}

function practiceBaseline() {
  return status({
    channel: 13,
    channelBandwidth: "40MHz",
    version: "VH-109_AP_PRACTICE_1.2.9-02102025",
    stationStatuses: Object.fromEntries(
      slots.map((slot, index) => [
        slot,
        {
          ssid: String(index + 1),
          hashedWpaKey: `hash-${slot}`,
          wpaKeySalt: `salt-${slot}`,
          isLinked: false,
          macAddress: "",
          signalDbm: 0,
        },
      ]),
    ),
  });
}

describe("VH113AccessPoint", () => {
  it("treats the inactive Practice firmware six-SSID baseline as empty", async () => {
    const api = fakeApi(practiceBaseline());
    const ap = new VH113AccessPoint({
      info: { id: "ap-1", name: "Field AP", managementAddress: "10.0.100.2" },
      fetch: api.fetch,
      pollIntervalMs: 0,
    });

    await expect(ap.getStationStatus("red1")).resolves.toMatchObject({
      state: "available",
    });
    await expect(ap.getStationStatus("blue3")).resolves.toMatchObject({
      state: "available",
    });

    await ap.configureTeam("red1", {
      teamNumber: 5712,
      ssid: "FRC-5712",
      wpaKey: "SecureKey123",
      vlanId: 10,
    });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.body).toMatchObject({
      stationConfigurations: {
        red1: { ssid: "FRC-5712", wpaKey: "SecureKey123" },
      },
    });
    await expect(ap.getStationStatus("blue3")).resolves.toMatchObject({
      state: "available",
    });
  });

  it("does not treat a partially matching Practice profile as empty", async () => {
    const baseline = practiceBaseline();
    const stationStatuses = baseline.stationStatuses as Record<
      string,
      Record<string, unknown>
    >;
    stationStatuses.red2 = { ...stationStatuses.red2, ssid: "FRC-862" };
    const api = fakeApi(baseline);
    const ap = new VH113AccessPoint({
      info: { id: "ap-1", name: "Field AP", managementAddress: "10.0.100.2" },
      fetch: api.fetch,
    });

    await expect(ap.getStationStatus("red1")).resolves.toMatchObject({
      state: "available",
    });
    await expect(
      ap.configureTeam("blue1", {
        teamNumber: 5712,
        ssid: "FRC-5712",
        wpaKey: "SecureKey123",
        vlanId: 40,
      }),
    ).rejects.toBeInstanceOf(AccessPointOperationError);
  });

  it("reads firmware and normalizes configured and associated stations", async () => {
    const api = fakeApi(
      status({
        stationStatuses: {
          red1: {
            ssid: "FRC-5712",
            hashedWpaKey: "hash",
            wpaKeySalt: "salt",
            isLinked: true,
            macAddress: "48:da:35:b0:01:cf",
            signalDbm: -53,
          },
          red2: null,
          red3: null,
          blue1: null,
          blue2: null,
          blue3: null,
        },
      }),
    );
    const ap = new VH113AccessPoint({
      info: { id: "ap-1", name: "Field AP", managementAddress: "10.0.100.2" },
      fetch: api.fetch,
    });

    expect(await ap.getInfo()).toMatchObject({
      manufacturer: "Vivid Hosting",
      model: "VH-113",
      firmwareVersion: "1.2.3",
    });
    expect(await ap.getStationStatus("red1")).toMatchObject({
      state: "associated",
      configuration: { teamNumber: 5712, vlanId: 10 },
      station: { macAddress: "48:DA:35:B0:01:CF", signalStrengthDbm: -53 },
    });
    expect(await ap.getStations()).toHaveLength(1);
  });

  it("applies and clears complete six-slot configuration documents", async () => {
    const api = fakeApi();
    const ap = new VH113AccessPoint({
      info: { id: "ap-1", name: "Field AP", managementAddress: "10.0.100.2" },
      fetch: api.fetch,
      pollIntervalMs: 0,
    });

    await ap.configureTeam("red1", {
      teamNumber: 5712,
      ssid: "FRC-5712",
      wpaKey: "SecureKey123",
      vlanId: 10,
    });
    await ap.configureTeam("blue1", {
      teamNumber: 862,
      ssid: "FRC-862",
      wpaKey: "OtherKey456",
      vlanId: 40,
    });
    expect(api.requests.at(-1)?.body).toMatchObject({
      redVlans: "10_20_30",
      blueVlans: "40_50_60",
      stationConfigurations: {
        red1: { ssid: "FRC-5712", wpaKey: "SecureKey123" },
        blue1: { ssid: "FRC-862", wpaKey: "OtherKey456" },
      },
    });

    await ap.clearTeam("red1");
    expect(api.requests.at(-1)?.body).toMatchObject({
      stationConfigurations: {
        blue1: { ssid: "FRC-862", wpaKey: "OtherKey456" },
      },
    });
    expect(
      (api.getStatus().stationStatuses as Record<string, unknown>).red1,
    ).toBeNull();
  });

  it("moves an unused alliance to another bank when the selected VLAN collides", async () => {
    const api = fakeApi();
    const ap = new VH113AccessPoint({
      info: {
        id: "ap-1",
        name: "Field AP",
        managementAddress: "10.0.100.2",
      },
      fetch: api.fetch,
      pollIntervalMs: 0,
    });

    await ap.configureTeam("red1", {
      teamNumber: 5712,
      ssid: "FRC-5712",
      wpaKey: "SecureKey123",
      vlanId: 40,
    });
    expect(api.requests.at(-1)?.body).toMatchObject({
      redVlans: "40_50_60",
      blueVlans: "10_20_30",
    });
  });

  it("refuses writes that would erase an externally configured slot", async () => {
    const stationStatuses = Object.fromEntries(
      slots.map((slot) => [slot, null]),
    );
    stationStatuses.red2 = {
      ssid: "FRC-1234",
      hashedWpaKey: "hash",
      wpaKeySalt: "salt",
      isLinked: false,
      macAddress: "",
      signalDbm: 0,
    };
    const api = fakeApi(status({ stationStatuses }));
    const ap = new VH113AccessPoint({
      info: { id: "ap-1", name: "Field AP", managementAddress: "10.0.100.2" },
      fetch: api.fetch,
    });

    await expect(
      ap.configureTeam("red1", {
        teamNumber: 5712,
        ssid: "FRC-5712",
        wpaKey: "SecureKey123",
        vlanId: 10,
      }),
    ).rejects.toBeInstanceOf(AccessPointOperationError);
    expect(api.requests).toHaveLength(0);
  });

  it("validates hardware-specific slot, VLAN, SSID, and key constraints", async () => {
    const api = fakeApi();
    const ap = new VH113AccessPoint({
      info: { id: "ap-1", name: "Field AP", managementAddress: "10.0.100.2" },
      fetch: api.fetch,
    });
    await expect(ap.getStationStatus("slot-1")).rejects.toBeInstanceOf(
      AccessPointSlotNotFoundError,
    );
    expect(() =>
      ap.configureTeam("red1", {
        teamNumber: 1,
        ssid: "FRC-1",
        wpaKey: "has-hyphen",
        vlanId: 10,
      }),
    ).toThrow("8-16 alphanumeric");
    expect(() =>
      ap.configureTeam("red1", {
        teamNumber: 1,
        ssid: "FRC-1",
        wpaKey: "SecureKey123",
        vlanId: 20,
      }),
    ).toThrow("supported VLANs are 10, 40, 70");
  });
});
