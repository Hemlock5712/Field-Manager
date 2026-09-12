import { afterEach, describe, expect, it } from "vitest";
import type { TeamNetworkRecord } from "@repo/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { createAppContext, type AppContext } from "./context.js";
import { DomainError } from "./networking/errors.js";
import { VlanAllocator } from "./networking/vlan-allocator.js";

const contexts: AppContext[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const context of contexts.splice(0)) context.database.close();
});

async function makeContext(seed = false): Promise<AppContext> {
  const context = await createAppContext({
    databasePath: ":memory:",
    seed,
    bounceDelayMs: 0,
  });
  contexts.push(context);
  return context;
}

function insertTeam(
  context: AppContext,
  id: string,
  teamNumber: number,
  vlanId: number,
): void {
  const now = new Date().toISOString();
  const record: TeamNetworkRecord = {
    id,
    teamNumber,
    vlanId,
    status: "offline",
    createdAt: now,
    updatedAt: now,
  };
  context.repository.insertTeamNetwork(record);
}

describe("VlanAllocator", () => {
  it("allocates unique VLANs, skips reserved VLANs, and persists allocations", async () => {
    const context = await makeContext();
    const config = context.repository.getConfig();
    context.repository.updateConfig({
      ...config,
      managementVlan: 10,
      onboardingVlan: 11,
      teamVlanStart: 10,
      teamVlanEnd: 13,
    });

    expect(context.vlanAllocator.allocate()).toBe(12);
    insertTeam(context, "team-a", 5712, 12);

    // A new allocator/repository view sees the same persisted allocation.
    expect(new VlanAllocator(context.repository).allocate()).toBe(13);
    expect(context.repository.listAllocatedVlans()).toEqual([12]);
  });

  it("releases a non-reserved VLAN for deterministic reuse and rejects reserved VLANs", async () => {
    const context = await makeContext();
    const config = context.repository.getConfig();
    context.repository.updateConfig({
      ...config,
      managementVlan: 10,
      onboardingVlan: 11,
      teamVlanStart: 10,
      teamVlanEnd: 12,
    });

    expect(() => context.vlanAllocator.release(10)).toThrowError(DomainError);
    expect(() => context.vlanAllocator.release(11)).toThrowError(DomainError);

    const allocated = context.vlanAllocator.allocate();
    expect(allocated).toBe(12);
    insertTeam(context, "team-a", 5712, allocated);
    expect(() => context.vlanAllocator.allocate()).toThrowError(DomainError);

    // release is intentionally validation-only; deletion is the persistence operation.
    context.vlanAllocator.release(allocated);
    context.repository.deleteTeamNetwork("team-a");
    expect(context.vlanAllocator.allocate()).toBe(allocated);
  });
});

describe("PortAssignmentService", () => {
  it("disabling a port forces link down and flushes learned MACs", async () => {
    const context = await makeContext(true);
    expect(await context.mockSwitch.getMacsOnPort("8")).toHaveLength(1);
    await context.ports.setEnabled("switch-1", "8", false);
    expect(await context.mockSwitch.getMacsOnPort("8")).toHaveLength(0);
    expect(await context.mockSwitch.getPort("8")).toMatchObject({
      enabled: false,
      linkUp: false,
    });
    await context.ports.setEnabled("switch-1", "8", true);
    expect(await context.mockSwitch.getPort("8")).toMatchObject({
      enabled: true,
      linkUp: false,
    });
  });

  it("moves an onboarding client port to a team VLAN", async () => {
    const context = await makeContext(true);

    const result = await context.ports.assignToTeam(
      "switch-1",
      "8",
      "team-5712",
      { bounce: false },
    );

    expect(result.teamNetworkId).toBe("team-5712");
    expect((await context.mockSwitch.getPort("8")).accessVlan).toBe(30);
  });

  it("moves a port from team A to team B", async () => {
    const context = await makeContext(true);

    await context.ports.assignToTeam("switch-1", "1", "team-862", {
      bounce: false,
    });

    expect(context.repository.getPortAssignment("switch-1", "1")).toMatchObject(
      { teamNetworkId: "team-862", role: "client" },
    );
    expect((await context.mockSwitch.getPort("1")).accessVlan).toBe(31);
  });

  it("returns a team port to the onboarding VLAN", async () => {
    const context = await makeContext(true);

    await context.ports.returnToOnboarding("switch-1", "1", false);

    expect(context.repository.getPortAssignment("switch-1", "1")).toMatchObject(
      { role: "client" },
    );
    expect(
      context.repository.getPortAssignment("switch-1", "1")?.teamNetworkId,
    ).toBeUndefined();
    expect((await context.mockSwitch.getPort("1")).accessVlan).toBe(999);
  });

  it("returning a disabled team port resets it, enables it, and flushes MACs", async () => {
    const context = await makeContext(true);
    await context.mockSwitch.setAccessVlan("1", 30);
    context.mockSwitch.learnMac("02:57:12:00:00:02", "1", 30);
    await context.mockSwitch.setPortEnabled("1", false);
    await context.ports.returnToOnboarding("switch-1", "1", false);
    expect(await context.mockSwitch.getPort("1")).toMatchObject({
      enabled: true,
      linkUp: false,
      accessVlan: 999,
    });
    expect(await context.mockSwitch.getMacsOnPort("1")).toHaveLength(0);
    expect(
      context.repository.getPortAssignment("switch-1", "1")?.teamNetworkId,
    ).toBeUndefined();
  });

  it("rejects management and AP-trunk ports as reserved", async () => {
    const context = await makeContext(true);

    await expect(
      context.ports.assignToTeam("switch-1", "22", "team-5712", {
        bounce: false,
      }),
    ).rejects.toMatchObject({ code: "RESERVED_PORT" });
    await expect(
      context.ports.assignToTeam("switch-1", "24", "team-5712", {
        bounce: false,
      }),
    ).rejects.toMatchObject({ code: "RESERVED_PORT" });
  });
});

describe("CaptivePortalService", () => {
  it("correlates requester IP -> DHCP lease -> MAC -> switch port", async () => {
    const context = await makeContext(true);

    const result = await context.portal.connect("10.99.0.42", 5712);

    expect(result).toEqual({
      teamNetworkId: "team-5712",
      switchId: "switch-1",
      portId: "8",
      vlanId: 30,
    });
    expect((await context.mockSwitch.getPort("8")).accessVlan).toBe(30);
    expect(context.repository.getPortAssignment("switch-1", "8")).toMatchObject(
      { teamNetworkId: "team-5712", role: "client" },
    );
  });

  it("rejects an IP whose lease MAC is not in the forwarding table", async () => {
    const context = await makeContext(true);
    context.leases.setLease({
      ip: "10.99.0.44",
      mac: "02:AA:BB:CC:DD:EE",
      vlanId: 999,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      context.portal.connect("10.99.0.44", 5712),
    ).rejects.toMatchObject({ code: "UNKNOWN_CLIENT" });
  });

  it("rejects a stale DHCP lease before touching the switch", async () => {
    const context = await makeContext(true);
    context.leases.setLease({
      ip: "10.99.0.45",
      mac: "02:AA:BB:CC:DD:EF",
      vlanId: 999,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect(
      context.portal.connect("10.99.0.45", 5712),
    ).rejects.toMatchObject({ code: "STALE_LEASE" });
  });

  it("reports switch unavailability", async () => {
    const context = await makeContext(true);
    context.mockSwitch.setAvailable(false);

    await expect(
      context.portal.connect("10.99.0.42", 5712),
    ).rejects.toMatchObject({ code: "HARDWARE_UNAVAILABLE" });
  });

  it("does not claim the port when the portal VLAN write fails", async () => {
    const context = await makeContext(true);
    context.mockSwitch.setFailure(
      "setAccessVlan",
      new Error("VLAN write refused"),
    );

    const error = await context.portal
      .connect("10.99.0.42", 5712)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "HARDWARE_WRITE_FAILED" });
    expect(
      context.repository.getPortAssignment("switch-1", "8"),
    ).not.toMatchObject({ teamNetworkId: "team-5712" });
  });

  it("reports a VLAN write failure and leaves the assignment unclaimed", async () => {
    const context = await makeContext(true);
    context.mockSwitch.setFailure(
      "setAccessVlan",
      new Error("VLAN write refused"),
    );

    await expect(
      context.ports.assignToTeam("switch-1", "8", "team-5712", {
        bounce: false,
      }),
    ).rejects.toMatchObject({ code: "HARDWARE_WRITE_FAILED" });
    expect(
      context.repository.getPortAssignment("switch-1", "8"),
    ).not.toMatchObject({ teamNetworkId: "team-5712" });
  });
});

describe("team-network creation", () => {
  it("surfaces an unavailable AP instead of creating a usable team network", async () => {
    const context = await makeContext(true);
    context.mockAccessPoint.setAvailable(false);

    await expect(
      context.teams.create({
        teamNumber: 9999,
        accessPointId: "ap-1",
        accessPointSlot: "slot-3",
      }),
    ).rejects.toMatchObject({ code: "HARDWARE_UNAVAILABLE" });
    expect(context.repository.getTeamNetworkByNumber(9999)).toBeUndefined();
  });
});

describe("NetworkHealthService", () => {
  it("detects switch and AP desired-versus-actual drift", async () => {
    const context = await makeContext(true);
    await context.mockSwitch.setAccessVlan("1", 999);
    await context.mockAccessPoint.configureTeam("slot-1", {
      teamNumber: 862,
      ssid: "FRC-862",
      vlanId: 31,
      wpaKey: "simulated",
    });

    const report = await context.health.inspect();

    expect(report.healthy).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "switch-port-drift", portId: "1" }),
        expect.objectContaining({
          kind: "access-point-drift",
          slotId: "slot-1",
        }),
      ]),
    );
  });
});

describe("development simulator endpoints", () => {
  it("exposes complete state and supports DHCP, port, AP, and failure controls", async () => {
    const context = await makeContext(true);
    const app = await buildApp(context);
    apps.push(app);

    const state = await app.inject({ method: "GET", url: "/api/dev/state" });
    expect(state.statusCode).toBe(200);
    const stateBody = state.json() as {
      mode: string;
      teams: unknown[];
      switches: unknown[];
      accessPoints: unknown[];
      leases: unknown[];
    };
    expect(stateBody.mode).toBe("mock");
    expect(stateBody.teams).toHaveLength(2);
    expect(stateBody.switches).toHaveLength(1);
    expect(stateBody.accessPoints).toHaveLength(1);
    expect(stateBody.leases).toHaveLength(1);

    const lease = await app.inject({
      method: "POST",
      url: "/api/dev/dhcp/leases",
      payload: { ip: "10.99.0.55", mac: "aa:bb:cc:dd:ee:01", vlanId: 999 },
    });
    expect(lease.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/dev/dhcp/leases/10.99.0.55",
        })
      ).statusCode,
    ).toBe(204);

    const port = await app.inject({
      method: "POST",
      url: "/api/dev/switches/switch-1/ports/8",
      payload: { enabled: false, clearMacs: true },
    });
    expect(port.statusCode).toBe(200);
    expect(port.json()).toMatchObject({ enabled: false, linkUp: false });
    const ap = await app.inject({
      method: "POST",
      url: "/api/dev/access-points/ap-1/stations/slot-1",
      payload: {
        associated: true,
        mac: "aa:bb:cc:dd:ee:02",
        signalStrengthDbm: -42,
      },
    });
    expect(ap.statusCode).toBe(200);
    expect(ap.json()).toMatchObject({
      state: "associated",
      station: { signalStrengthDbm: -42 },
    });

    const failure = await app.inject({
      method: "POST",
      url: "/api/dev/failures",
      payload: {
        hardware: "switch",
        operation: "getPorts",
        message: "simulated timeout",
      },
    });
    expect(failure.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/switches/switch-1/ports" }))
        .statusCode,
    ).toBe(500);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/dev/failures",
          payload: { hardware: "switch", operation: "getPorts", message: null },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("supports safe desired-state reset and explicit seeded-demo reset", async () => {
    const context = await makeContext(true);
    const app = await buildApp(context);
    apps.push(app);
    await context.mockSwitch.setAccessVlan("1", 123);
    context.mockSwitch.learnMac("02:57:12:00:00:03", "1", 123);
    await context.mockAccessPoint.configureTeam("slot-3", {
      teamNumber: 9999,
      ssid: "FRC-9999",
      vlanId: 45,
    });
    const reset = await app.inject({
      method: "POST",
      url: "/api/dev/reset",
      payload: { mode: "hardware-to-desired" },
    });
    expect(reset.statusCode).toBe(200);
    expect(await context.mockSwitch.getPort("1")).toMatchObject({
      accessVlan: 30,
      enabled: true,
      linkUp: false,
    });
    expect(await context.mockSwitch.getMacsOnPort("1")).toHaveLength(0);
    expect(
      (await context.mockAccessPoint.getStationStatus("slot-1")).state,
    ).toBe("configured");
    expect(
      (await context.mockAccessPoint.getStationStatus("slot-3")).state,
    ).toBe("available");

    await app.inject({
      method: "POST",
      url: "/api/team-networks",
      payload: { teamNumber: 9999 },
    });
    const seeded = await app.inject({
      method: "POST",
      url: "/api/dev/reset",
      payload: { mode: "seeded-demo" },
    });
    expect(seeded.statusCode).toBe(200);
    const seededBody = seeded.json() as {
      teams: Array<{ teamNumber: number }>;
      leases: unknown[];
    };
    expect(seededBody.teams.map((team) => team.teamNumber).sort()).toEqual(
      [5712, 862].sort(),
    );
    expect(seededBody.leases).toHaveLength(1);
  });

  it("reset recovers simulated availability and injected failures", async () => {
    const context = await makeContext(true);
    const app = await buildApp(context);
    apps.push(app);
    context.mockSwitch.setAvailable(false);
    context.mockSwitch.setFailure("getPorts", new Error("broken"));
    context.mockAccessPoint.setAvailable(false);
    context.mockAccessPoint.setFailure("getStationStatus", new Error("broken"));

    const reset = await app.inject({
      method: "POST",
      url: "/api/dev/reset",
      payload: { scope: "hardware" },
    });
    expect(reset.statusCode).toBe(200);
    expect(context.mockSwitch.isAvailable()).toBe(true);
    expect(context.mockAccessPoint.isAvailable()).toBe(true);
    expect((await context.mockSwitch.getPorts()).length).toBe(24);
    expect(
      (await context.mockAccessPoint.getStationStatus("slot-1")).state,
    ).toBe("configured");
  });
});

describe("REST API", () => {
  it("serves a safe overview and completes the simulated portal handoff", async () => {
    const context = await makeContext(true);
    const app = await buildApp(context);
    apps.push(app);

    const overview = await app.inject({ method: "GET", url: "/api/overview" });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      config: { onboardingVlan: 999 },
      teamNetworks: expect.arrayContaining([
        expect.objectContaining({ teamNumber: 5712, vlanId: 30 }),
      ]),
    });
    expect(overview.body).not.toContain("demo-5712-key");

    const connect = await app.inject({
      method: "POST",
      url: "/api/portal/connect",
      payload: { teamNumber: 5712, ip: "10.99.0.42" },
    });
    expect(connect.statusCode).toBe(200);
    expect(connect.json()).toMatchObject({ portId: "8", vlanId: 30 });
  });

  it("returns structured Zod validation errors", async () => {
    const context = await makeContext(true);
    const app = await buildApp(context);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/team-networks",
      payload: { teamNumber: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
