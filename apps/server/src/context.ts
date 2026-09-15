import {
  MockAccessPoint,
  VH113AccessPoint,
  type TeamWirelessConfiguration,
} from "@repo/ap";
import type { ApplicationPortRole, DhcpLeaseProvider } from "@repo/core";
import {
  LocalSqliteCredentialStore,
  createDatabase,
  FieldRepository,
} from "@repo/db";
import {
  Extreme5420FabricEngineSwitch,
  Extreme5420Switch,
  MockManagedSwitch,
} from "@repo/switch";
import { readFile } from "node:fs/promises";
import { CaptivePortalService } from "./networking/captive-portal-service.js";
import {
  DnsmasqLeaseProvider,
  MockDhcpLeaseProvider,
} from "./networking/dhcp.js";
import { NetworkHealthService } from "./networking/reconciliation-service.js";
import { HardwareRegistry } from "./networking/registry.js";
import { PortAssignmentService } from "./networking/port-assignment-service.js";
import { TeamNetworkService } from "./networking/team-network-service.js";
import { VlanAllocator } from "./networking/vlan-allocator.js";
import { SimulationService } from "./networking/simulation-service.js";

export interface AppContext {
  mode: "mock" | "production";
  database: ReturnType<typeof createDatabase>;
  repository: FieldRepository;
  hardware: HardwareRegistry;
  leases: DhcpLeaseProvider;
  credentials: LocalSqliteCredentialStore;
  vlanAllocator: VlanAllocator;
  ports: PortAssignmentService;
  teams: TeamNetworkService;
  portal: CaptivePortalService;
  health: NetworkHealthService;
  simulation?: SimulationService;
}

export interface DevelopmentAppContext extends AppContext {
  mode: "mock";
  mockSwitch: MockManagedSwitch;
  mockAccessPoint: MockAccessPoint;
  leases: MockDhcpLeaseProvider;
  simulation: SimulationService;
}

export async function createAppContext(
  options: {
    databasePath?: string;
    seed?: boolean;
    bounceDelayMs?: number;
  } = {},
): Promise<DevelopmentAppContext> {
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
    mode: "mock" as const,
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
  const context: DevelopmentAppContext = { ...contextBase, simulation };
  if (options.seed ?? true) await seedDemo(context);
  return context;
}

const defaultPortIds = Array.from({ length: 52 }, (_, index) =>
  String(index + 1),
);
const defaultFabricEnginePortIds = Array.from(
  { length: 52 },
  (_, index) => `1/${index + 1}`,
);

function switchOperatingSystem(
  environment: NodeJS.ProcessEnv,
): "switch-engine" | "fabric-engine" {
  const value = environment.FM_SWITCH_OS?.trim().toLowerCase();
  if (!value || value === "switch-engine" || value === "exos")
    return "switch-engine";
  if (value === "fabric-engine" || value === "voss") return "fabric-engine";
  throw new TypeError(
    "FM_SWITCH_OS must be switch-engine, exos, fabric-engine, or voss",
  );
}

function envValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
): string {
  const value = environment[name]?.trim() || fallback;
  if (!value)
    throw new TypeError(
      `Production mode requires environment variable ${name}`,
    );
  return value;
}

function envInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum = 1,
  maximum = 4094,
): number {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  return value;
}

function envList(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string[] = [],
): string[] {
  const raw = environment[name];
  const values =
    raw === undefined || raw.trim() === "" ? fallback : raw.split(",");
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length)
    throw new RangeError(`${name} must not contain duplicate port IDs`);
  return normalized;
}

function envBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new TypeError(`${name} must be true or false`);
}

async function envSecret(
  environment: NodeJS.ProcessEnv,
  name: string,
  required = true,
): Promise<string | undefined> {
  const inline = environment[name]?.trim();
  if (inline) return inline;
  const file = environment[`${name}_FILE`]?.trim();
  if (file) {
    const secret = (await readFile(file, "utf8")).trim();
    if (secret) return secret;
    if (!required) return undefined;
    throw new TypeError(`${name}_FILE points to an empty file`);
  }
  if (required)
    throw new TypeError(`Production mode requires ${name} or ${name}_FILE`);
  return undefined;
}

function channelBandwidth(environment: NodeJS.ProcessEnv): "20MHz" | "40MHz" {
  const value = environment.FM_AP_CHANNEL_BANDWIDTH?.trim() || "20MHz";
  if (value !== "20MHz" && value !== "40MHz")
    throw new TypeError("FM_AP_CHANNEL_BANDWIDTH must be 20MHz or 40MHz");
  return value;
}

function assertDisjointPortRoles(
  groups: Array<[string, readonly string[]]>,
): void {
  const owners = new Map<string, string>();
  for (const [name, ports] of groups) {
    for (const port of ports) {
      const owner = owners.get(port);
      if (owner)
        throw new RangeError(
          `Switch port ${port} appears in both ${owner} and ${name}`,
        );
      owners.set(port, name);
    }
  }
}

export async function createProductionAppContext(
  options: {
    databasePath?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<AppContext> {
  const environment = options.environment ?? process.env;
  const database = createDatabase(options.databasePath);
  try {
    const repository = new FieldRepository(database);
    const existingConfig = repository.getConfig();
    const config = {
      ...existingConfig,
      managementVlan: envInteger(
        environment,
        "FM_MANAGEMENT_VLAN",
        existingConfig.managementVlan,
      ),
      onboardingVlan: envInteger(
        environment,
        "FM_ONBOARDING_VLAN",
        existingConfig.onboardingVlan,
      ),
      portBounceDelayMs: envInteger(
        environment,
        "FM_PORT_BOUNCE_DELAY_MS",
        existingConfig.portBounceDelayMs,
        0,
        60_000,
      ),
    };
    if (config.managementVlan === config.onboardingVlan)
      throw new RangeError("Management and onboarding VLANs must differ");

    const switchId = environment.FM_SWITCH_ID?.trim() || "switch-1";
    const accessPointId = environment.FM_AP_ID?.trim() || "ap-1";
    const switchOs = switchOperatingSystem(environment);
    const switchUrl = envValue(environment, "FM_SWITCH_URL");
    const accessPointUrl = envValue(environment, "FM_AP_URL");
    const portIds = envList(
      environment,
      "FM_SWITCH_PORT_IDS",
      switchOs === "fabric-engine"
        ? defaultFabricEnginePortIds
        : defaultPortIds,
    );
    const clientPorts = envList(environment, "FM_SWITCH_CLIENT_PORTS");
    const apTrunkPorts = envList(environment, "FM_SWITCH_AP_TRUNK_PORTS");
    if (clientPorts.length === 0)
      throw new TypeError(
        "Production mode requires at least one FM_SWITCH_CLIENT_PORTS entry",
      );
    if (apTrunkPorts.length === 0)
      throw new TypeError(
        "Production mode requires at least one FM_SWITCH_AP_TRUNK_PORTS entry",
      );
    const serverPorts = envList(environment, "FM_SWITCH_SERVER_PORTS");
    const managementPorts = envList(environment, "FM_SWITCH_MANAGEMENT_PORTS");
    const unusedPorts = envList(environment, "FM_SWITCH_UNUSED_PORTS");
    const roleGroups: Array<[ApplicationPortRole, string[]]> = [
      ["client", clientPorts],
      ["ap-trunk", apTrunkPorts],
      ["server", serverPorts],
      ["management", managementPorts],
      ["unused", unusedPorts],
    ];
    assertDisjointPortRoles(roleGroups);
    const knownPorts = new Set(portIds);
    for (const [, ports] of roleGroups)
      for (const port of ports)
        if (!knownPorts.has(port))
          throw new RangeError(
            `Switch role configuration refers to unknown port ${port}`,
          );
    const portRoles = Object.fromEntries(
      roleGroups.flatMap(([role, ports]) =>
        ports.map((port) => [port, role] as const),
      ),
    );

    const switchPassword = await envSecret(environment, "FM_SWITCH_PASSWORD");
    const accessPointToken = await envSecret(environment, "FM_AP_TOKEN", false);
    const credentials = new LocalSqliteCredentialStore(database);
    const initialConfigurations: Record<string, TeamWirelessConfiguration> = {};
    for (const team of repository.listTeamNetworks()) {
      if (team.accessPointId !== accessPointId || !team.accessPointSlot)
        continue;
      const wpaKey = team.credentialRef
        ? await credentials.get(team.credentialRef)
        : undefined;
      if (!wpaKey) continue;
      initialConfigurations[team.accessPointSlot] = {
        teamNumber: team.teamNumber,
        ssid: team.wirelessSsid ?? `FRC-${team.teamNumber}`,
        wpaKey,
        vlanId: team.vlanId,
      };
    }

    const switchOptions = {
      info: {
        id: switchId,
        name: environment.FM_SWITCH_NAME?.trim() || "Field Switch",
        managementAddress: switchUrl,
      },
      username: envValue(environment, "FM_SWITCH_USER"),
      password: switchPassword!,
      managementVlan: config.managementVlan,
      onboardingVlan: config.onboardingVlan,
      portIds,
      clientPorts,
      apTrunkPorts,
      portRoles,
      bounceDelayMs: config.portBounceDelayMs,
      saveConfiguration: envBoolean(
        environment,
        "FM_SWITCH_SAVE_CONFIGURATION",
        true,
      ),
    };
    const managedSwitch =
      switchOs === "fabric-engine"
        ? new Extreme5420FabricEngineSwitch({
            ...switchOptions,
            address: switchUrl,
            hostKeySha256: envValue(
              environment,
              "FM_SWITCH_SSH_HOST_KEY_SHA256",
            ),
            allowLegacySha1Kex: envBoolean(
              environment,
              "FM_SWITCH_ALLOW_LEGACY_SSH_KEX",
              false,
            ),
          })
        : new Extreme5420Switch({
            ...switchOptions,
            baseUrl: switchUrl,
          });
    const accessPoint = new VH113AccessPoint({
      info: {
        id: accessPointId,
        name: environment.FM_AP_NAME?.trim() || "Field VH-113",
        managementAddress: accessPointUrl,
      },
      baseUrl: accessPointUrl,
      ...(accessPointToken ? { token: accessPointToken } : {}),
      channel: envInteger(environment, "FM_AP_CHANNEL", 157, 1, 196),
      channelBandwidth: channelBandwidth(environment),
      initialConfigurations,
    });
    const hardware = new HardwareRegistry();
    hardware.registerSwitch(switchId, managedSwitch);
    hardware.registerAccessPoint(accessPointId, accessPoint);
    const leases = new DnsmasqLeaseProvider({
      leaseFilePath: envValue(environment, "FIELD_MANAGER_DHCP_LEASE_FILE"),
      vlanId: config.onboardingVlan,
    });
    for (const existing of repository.listPortAssignments(switchId)) {
      if (existing.teamNetworkId && !knownPorts.has(existing.portId))
        throw new RangeError(
          `Previously assigned switch port ${existing.portId} is absent from FM_SWITCH_PORT_IDS`,
        );
      if (
        existing.teamNetworkId &&
        (portRoles[existing.portId] ?? "unused") !== "client"
      )
        throw new RangeError(
          `Previously assigned switch port ${existing.portId} is no longer configured as a client port`,
        );
    }
    repository.runInTransaction(() => {
      repository.updateConfig(config);
      repository.upsertSwitch({
        id: switchId,
        displayName: environment.FM_SWITCH_NAME?.trim() || "Field Switch",
        adapterType:
          switchOs === "fabric-engine"
            ? "extreme-5420m-48w-4ye-fabric-engine"
            : "extreme-5420m-48w-4ye-switch-engine",
        managementAddress: switchUrl,
        metadata: { switchOs, portIds, clientPorts, apTrunkPorts },
      });
      repository.upsertAccessPoint({
        id: accessPointId,
        displayName: environment.FM_AP_NAME?.trim() || "Field VH-113",
        adapterType: "vh113-frc-radio-api",
        managementAddress: accessPointUrl,
        metadata: { firmwareProfile: "practice" },
      });
      for (const portId of portIds) {
        const existing = repository.getPortAssignment(switchId, portId);
        repository.upsertPortAssignment({
          switchId,
          portId,
          role: portRoles[portId] ?? "unused",
          ...(existing?.teamNetworkId
            ? { teamNetworkId: existing.teamNetworkId }
            : {}),
          ...(existing?.label ? { label: existing.label } : {}),
        });
      }
    });

    const vlanAllocator = new VlanAllocator(repository);
    const ports = new PortAssignmentService(repository, hardware);
    const teams = new TeamNetworkService(
      repository,
      vlanAllocator,
      hardware,
      credentials,
      ports,
    );
    const portal = new CaptivePortalService(
      repository,
      leases,
      hardware,
      ports,
    );
    const health = new NetworkHealthService(repository, hardware);
    return {
      mode: "production",
      database,
      repository,
      hardware,
      leases,
      credentials,
      vlanAllocator,
      ports,
      teams,
      portal,
      health,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

async function resetSeededDemo(
  context: Omit<DevelopmentAppContext, "simulation">,
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
  context: Omit<DevelopmentAppContext, "simulation">,
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
      wirelessSsid: "FRC-5712",
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
      wirelessSsid: "FRC-862",
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
          ssid: team.wirelessSsid ?? `FRC-${team.teamNumber}`,
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
