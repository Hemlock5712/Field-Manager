import { MockAccessPoint } from "@repo/ap";
import {
  LocalSqliteCredentialStore,
  createDatabase,
  FieldRepository,
} from "@repo/db";
import { MockManagedSwitch } from "@repo/switch";
import { CaptivePortalService } from "./networking/captive-portal-service.js";
import { MockDhcpLeaseProvider } from "./networking/dhcp.js";
import { NetworkHealthService } from "./networking/reconciliation-service.js";
import { HardwareRegistry } from "./networking/registry.js";
import { PortAssignmentService } from "./networking/port-assignment-service.js";
import { TeamNetworkService } from "./networking/team-network-service.js";
import { VlanAllocator } from "./networking/vlan-allocator.js";
import { SimulationService } from "./networking/simulation-service.js";

export interface AppContext {
  database: ReturnType<typeof createDatabase>;
  repository: FieldRepository;
  hardware: HardwareRegistry;
  mockSwitch: MockManagedSwitch;
  mockAccessPoint: MockAccessPoint;
  leases: MockDhcpLeaseProvider;
  credentials: LocalSqliteCredentialStore;
  vlanAllocator: VlanAllocator;
  ports: PortAssignmentService;
  teams: TeamNetworkService;
  portal: CaptivePortalService;
  health: NetworkHealthService;
  simulation: SimulationService;
}

export async function createAppContext(
  options: {
    databasePath?: string;
    seed?: boolean;
    bounceDelayMs?: number;
  } = {},
): Promise<AppContext> {
  const database = createDatabase(options.databasePath);
  const repository = new FieldRepository(database);
  if (options.bounceDelayMs !== undefined) {
    repository.updateConfig({
      ...repository.getConfig(),
      portBounceDelayMs: options.bounceDelayMs,
    });
  }
  const config = repository.getConfig();
  const mockSwitch = new MockManagedSwitch({
    portCount: 24,
    managementVlan: config.managementVlan,
    onboardingVlan: config.onboardingVlan,
    bounceDelayMs: options.bounceDelayMs ?? 0,
    info: {
      id: "switch-1",
      name: "Field Switch",
      managementAddress: "mock://switch-1",
    },
    clientPorts: Array.from({ length: 20 }, (_, index) => String(index + 1)),
    apTrunkPorts: ["24"],
    initialPorts: [
      { id: "21", role: "server", accessVlan: config.managementVlan },
      { id: "22", role: "management", accessVlan: config.managementVlan },
      { id: "23", role: "unused", accessVlan: config.onboardingVlan },
      {
        id: "24",
        role: "ap-trunk",
        mode: "trunk",
        nativeVlan: config.managementVlan,
      },
    ],
  });
  const mockAccessPoint = new MockAccessPoint({
    info: {
      id: "ap-1",
      name: "Practice Field VH-113",
      managementAddress: "mock://ap-1",
    },
  });
  const hardware = new HardwareRegistry();
  hardware.registerSwitch("switch-1", mockSwitch);
  hardware.registerAccessPoint("ap-1", mockAccessPoint);
  const leases = new MockDhcpLeaseProvider();
  const credentials = new LocalSqliteCredentialStore(database);
  const vlanAllocator = new VlanAllocator(repository);
  const ports = new PortAssignmentService(repository, hardware);
  const teams = new TeamNetworkService(
    repository,
    vlanAllocator,
    hardware,
    credentials,
    ports,
  );
  const portal = new CaptivePortalService(repository, leases, hardware, ports);
  const health = new NetworkHealthService(repository, hardware);
  const contextBase = {
    database,
    repository,
    hardware,
    mockSwitch,
    mockAccessPoint,
    leases,
    credentials,
    vlanAllocator,
    ports,
    teams,
    portal,
    health,
  };
  const simulation = new SimulationService(
    repository,
    hardware,
    mockSwitch,
    mockAccessPoint,
    leases,
    credentials,
    async () => resetSeededDemo(context),
  );
  const context: AppContext = { ...contextBase, simulation };
  if (options.seed ?? true) await seedDemo(context);
  return context;
}

async function resetSeededDemo(
  context: Omit<AppContext, "simulation">,
): Promise<void> {
  const { repository, mockSwitch, mockAccessPoint, leases, credentials } =
    context;
  for (const team of repository.listTeamNetworks()) {
    if (team.credentialRef) await credentials.delete(team.credentialRef);
    repository.clearTeamFromPorts(team.id);
    repository.deleteTeamNetwork(team.id);
  }
  const roles = new Map<
    string,
    "client" | "server" | "management" | "unused" | "ap-trunk"
  >([
    ["21", "server"],
    ["22", "management"],
    ["23", "unused"],
    ["24", "ap-trunk"],
  ]);
  for (const assignment of repository.listPortAssignments()) {
    repository.upsertPortAssignment({
      switchId: assignment.switchId,
      portId: assignment.portId,
      role: roles.get(assignment.portId) ?? "client",
      label: undefined,
    });
  }
  for (const lease of leases.listLeases()) leases.removeLeaseByIp(lease.ip);
  mockSwitch.setAvailable(true);
  mockSwitch.clearFailures();
  mockSwitch.clearMacTable();
  mockAccessPoint.setAvailable(true);
  mockAccessPoint.clearFailures();
  for (const slotId of (await mockAccessPoint.getCapabilities()).slotIds) {
    await mockAccessPoint.clearTeam(slotId);
  }
  await seedDemo(context);
}

async function seedDemo(
  context: Omit<AppContext, "simulation">,
): Promise<void> {
  const { repository, mockSwitch, mockAccessPoint, leases } = context;
  const config = repository.getConfig();
  repository.upsertSwitch({
    id: "switch-1",
    displayName: "Field Switch",
    adapterType: "mock",
    managementAddress: "mock://switch-1",
    metadata: { portCount: 24 },
  });
  repository.upsertAccessPoint({
    id: "ap-1",
    displayName: "Practice Field VH-113",
    adapterType: "mock-vh113",
    managementAddress: "mock://ap-1",
    metadata: { maxStations: 6 },
  });

  const roles = new Map<
    string,
    "client" | "server" | "management" | "unused" | "ap-trunk"
  >([
    ["21", "server"],
    ["22", "management"],
    ["23", "unused"],
    ["24", "ap-trunk"],
  ]);
  for (let index = 1; index <= 24; index += 1) {
    const portId = String(index);
    if (!repository.getPortAssignment("switch-1", portId)) {
      repository.upsertPortAssignment({
        switchId: "switch-1",
        portId,
        role: roles.get(portId) ?? "client",
      });
    }
  }

  if (repository.listTeamNetworks().length === 0) {
    const now = new Date().toISOString();
    repository.insertTeamNetwork({
      id: "team-5712",
      teamNumber: 5712,
      vlanId: 30,
      accessPointId: "ap-1",
      accessPointSlot: "slot-1",
      credentialRef: "team/team-5712/wireless-key",
      status: "online",
      createdAt: now,
      updatedAt: now,
    });
    repository.insertTeamNetwork({
      id: "team-862",
      teamNumber: 862,
      vlanId: 31,
      accessPointId: "ap-1",
      accessPointSlot: "slot-2",
      credentialRef: "team/team-862/wireless-key",
      status: "online",
      createdAt: now,
      updatedAt: now,
    });
    await new LocalSqliteCredentialStore(context.database).put(
      "team/team-5712/wireless-key",
      "demo-5712-key",
    );
    await new LocalSqliteCredentialStore(context.database).put(
      "team/team-862/wireless-key",
      "demo-862-key",
    );
    repository.upsertPortAssignment({
      switchId: "switch-1",
      portId: "1",
      teamNetworkId: "team-5712",
      role: "client",
      label: "Driver Station",
    });
    repository.upsertPortAssignment({
      switchId: "switch-1",
      portId: "4",
      teamNetworkId: "team-862",
      role: "client",
      label: "Driver Station",
    });
  }

  for (const team of repository.listTeamNetworks()) {
    if (team.accessPointId === "ap-1" && team.accessPointSlot) {
      try {
        await mockAccessPoint.configureTeam(team.accessPointSlot, {
          teamNumber: team.teamNumber,
          ssid: `FRC-${team.teamNumber}`,
          vlanId: team.vlanId,
          wpaKey: "simulated",
        });
        if (team.status === "online")
          mockAccessPoint.simulateAssociation(team.accessPointSlot, {
            macAddress:
              `02:00:00:${String(team.teamNumber).padStart(6, "0").match(/../g)!.join(":")}`.slice(
                0,
                17,
              ),
            signalStrengthDbm: team.teamNumber === 5712 ? -48 : -57,
          });
      } catch {
        // Existing records may reference another adapter/slot; reconciliation reports it.
      }
    }
  }
  for (const assignment of repository.listPortAssignments("switch-1")) {
    if (assignment.role === "client" || assignment.role === "unused") {
      const team = assignment.teamNetworkId
        ? repository.getTeamNetwork(assignment.teamNetworkId)
        : undefined;
      await mockSwitch.setAccessVlan(
        assignment.portId,
        team?.vlanId ?? config.onboardingVlan,
      );
    }
  }
  await mockSwitch.setTrunkVlans(
    "24",
    repository.listAllocatedVlans(),
    config.managementVlan,
  );
  mockSwitch.simulateLink("1", true);
  mockSwitch.learnMac("00:57:12:00:00:01", "1", 30);
  mockSwitch.simulateLink("4", true);
  mockSwitch.learnMac("00:08:62:00:00:01", "4", 31);
  mockSwitch.simulateLink("8", true);
  mockSwitch.learnMac("AA:BB:CC:DD:EE:FF", "8", config.onboardingVlan);
  leases.setLease({
    ip: "10.99.0.42",
    mac: "AA:BB:CC:DD:EE:FF",
    vlanId: config.onboardingVlan,
    hostname: "pit-laptop",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}
