import type {
  AccessPoint,
  MockAccessPoint,
  MockApFailureOperation,
} from "@repo/ap";
import type { DhcpLease, CredentialStore } from "@repo/core";
import type { FieldRepository } from "@repo/db";
import type {
  ManagedSwitch,
  MockManagedSwitch,
  MockSwitchFailureOperation,
} from "@repo/switch";
import { DomainError } from "./errors.js";
import { HardwareRegistry } from "./registry.js";
import { toTeamNetwork } from "./mappers.js";
import type { MockDhcpLeaseProvider } from "./dhcp.js";

export interface PortSimulationInput {
  enabled?: boolean;
  linkUp?: boolean;
  mac?: string;
  vlanId?: number;
  clearMacs?: boolean;
}

export interface StationSimulationInput {
  associated?: boolean;
  mac?: string;
  signalStrengthDbm?: number;
}

export interface SimulationState {
  mode: "mock";
  config: ReturnType<FieldRepository["getConfig"]>;
  /** Compatibility summaries retained alongside the complete hardware snapshots. */
  switchAvailable: boolean;
  accessPointAvailable: boolean;
  teams: unknown[];
  switches: unknown[];
  accessPoints: unknown[];
  leases: DhcpLease[];
}

type SimulatedSwitch = MockManagedSwitch & {
  setFailure?: (operation: MockSwitchFailureOperation, error?: Error) => void;
  clearFailures?: () => void;
};
type SimulatedAccessPoint = MockAccessPoint & {
  setFailure?: (operation: MockApFailureOperation, error?: Error) => void;
  clearFailures?: () => void;
};
const SWITCH_FAILURES: readonly MockSwitchFailureOperation[] = [
  "getInfo",
  "getCapabilities",
  "getPorts",
  "getPort",
  "setAccessVlan",
  "setTrunkVlans",
  "setPortEnabled",
  "bouncePort",
  "getMacTable",
  "getMacsOnPort",
  "findPortByMac",
  "resetPort",
  "clearMacsOnPort",
];
const AP_FAILURES: readonly MockApFailureOperation[] = [
  "getInfo",
  "getCapabilities",
  "getStations",
  "configureTeam",
  "clearTeam",
  "getStationStatus",
];

/** Dev-only controls for deterministic hardware simulation. Routes delegate all mutation here. */
export class SimulationService {
  constructor(
    private readonly repository: FieldRepository,
    private readonly hardware: HardwareRegistry,
    private readonly mockSwitch: SimulatedSwitch,
    private readonly mockAccessPoint: SimulatedAccessPoint,
    private readonly leases: MockDhcpLeaseProvider,
    private readonly credentials?: CredentialStore,
    private readonly resetSeededDemo?: () => Promise<void>,
  ) {}

  async state(): Promise<SimulationState> {
    const teams = this.repository.listTeamNetworks().map((record) => ({
      ...toTeamNetwork(record),
      wiredPorts: this.repository
        .listPortAssignments()
        .filter((assignment) => assignment.teamNetworkId === record.id),
    }));
    const switches = await Promise.all(
      this.hardware.listSwitches().map(async ([id, managedSwitch]) => {
        try {
          const [info, capabilities, ports] = await Promise.all([
            managedSwitch.getInfo(),
            managedSwitch.getCapabilities(),
            managedSwitch.getPorts(),
          ]);
          const assignments = new Map(
            this.repository
              .listPortAssignments(id)
              .map((item) => [item.portId, item]),
          );
          const details = await Promise.all(
            ports.map(async (port) => ({
              ...port,
              assignment: assignments.get(port.id),
              learnedMacs: await managedSwitch.getMacsOnPort(port.id),
            })),
          );
          return {
            id,
            available: true,
            info,
            capabilities,
            ports: details,
            macTable: await managedSwitch.getMacTable(),
          };
        } catch (error) {
          return { id, available: false, error: String(error) };
        }
      }),
    );
    const accessPoints = await Promise.all(
      this.hardware.listAccessPoints().map(async ([id, accessPoint]) => {
        try {
          const [info, capabilities] = await Promise.all([
            accessPoint.getInfo(),
            accessPoint.getCapabilities(),
          ]);
          const stations = await Promise.all(
            capabilities.slotIds.map(async (slotId) =>
              this.publicStation(await accessPoint.getStationStatus(slotId)),
            ),
          );
          return { id, available: true, info, capabilities, stations };
        } catch (error) {
          return { id, available: false, error: String(error) };
        }
      }),
    );
    return {
      mode: "mock",
      config: this.repository.getConfig(),
      switchAvailable: this.mockSwitch.isAvailable(),
      accessPointAvailable: this.mockAccessPoint.isAvailable(),
      teams,
      switches,
      accessPoints,
      leases: this.leases.listLeases(),
    };
  }

  setSwitchAvailability(switchId: string, available: boolean): void {
    this.requireSwitch(switchId);
    this.mockSwitch.setAvailable(available);
  }

  async simulatePort(
    switchId: string,
    portId: string,
    input: PortSimulationInput,
  ): Promise<unknown> {
    const managedSwitch = this.requireSwitch(switchId) as SimulatedSwitch;
    if (input.enabled !== undefined)
      await managedSwitch.setPortEnabled(portId, input.enabled);
    if (input.clearMacs) await managedSwitch.clearMacsOnPort?.(portId);
    if (input.linkUp !== undefined)
      managedSwitch.simulateLink(portId, input.linkUp);
    if (
      input.mac !== undefined &&
      (await managedSwitch.getPort(portId)).enabled
    )
      managedSwitch.learnMac(input.mac, portId, input.vlanId);
    return managedSwitch.getPort(portId);
  }

  setAccessPointAvailability(accessPointId: string, available: boolean): void {
    this.requireAccessPoint(accessPointId);
    this.mockAccessPoint.setAvailable(available);
  }

  async simulateStation(
    accessPointId: string,
    slotId: string,
    input: StationSimulationInput,
  ): Promise<unknown> {
    const accessPoint = this.requireAccessPoint(
      accessPointId,
    ) as SimulatedAccessPoint;
    if (input.associated === false) accessPoint.simulateDisassociation(slotId);
    else if (input.associated === true || input.mac !== undefined)
      accessPoint.simulateAssociation(slotId, {
        macAddress: input.mac ?? "02:00:00:00:00:01",
        signalStrengthDbm: input.signalStrengthDbm,
      });
    else if (input.signalStrengthDbm !== undefined)
      accessPoint.simulateSignal(slotId, input.signalStrengthDbm);
    return this.publicStation(await accessPoint.getStationStatus(slotId));
  }

  createLease(lease: DhcpLease): DhcpLease {
    this.leases.setLease(lease);
    return { ...lease, mac: lease.mac.toUpperCase().replaceAll("-", ":") };
  }
  deleteLease(ip: string): void {
    this.leases.removeLeaseByIp(ip);
  }

  setFailure(
    hardware: "switch" | "access-point",
    operation: string,
    message?: string,
    hardwareId?: string,
  ): void {
    const error = message ? new Error(message) : undefined;
    if (hardware === "switch") {
      if (!SWITCH_FAILURES.includes(operation as MockSwitchFailureOperation))
        throw new DomainError(
          "VALIDATION_ERROR",
          `Unsupported mock switch operation: ${operation}`,
          400,
        );
      const target = this.requireSwitch(
        hardwareId ?? "switch-1",
      ) as SimulatedSwitch;
      if (!target.setFailure)
        throw new DomainError(
          "CONFLICT",
          "The selected switch is not a controllable mock",
          409,
        );
      target.setFailure(operation as MockSwitchFailureOperation, error);
    } else {
      if (!AP_FAILURES.includes(operation as MockApFailureOperation))
        throw new DomainError(
          "VALIDATION_ERROR",
          `Unsupported mock access-point operation: ${operation}`,
          400,
        );
      const target = this.requireAccessPoint(
        hardwareId ?? "ap-1",
      ) as SimulatedAccessPoint;
      if (!target.setFailure)
        throw new DomainError(
          "CONFLICT",
          "The selected access point is not a controllable mock",
          409,
        );
      target.setFailure(operation as MockApFailureOperation, error);
    }
  }

  /** Reapply persisted desired VLAN/AP state without deleting teams or leases. */
  async resetHardwareToDesired(): Promise<void> {
    const config = this.repository.getConfig();
    const teams = new Map(
      this.repository.listTeamNetworks().map((team) => [team.id, team]),
    );
    for (const [switchId, managedSwitch] of this.hardware.listSwitches()) {
      const assignments = new Map(
        this.repository
          .listPortAssignments(switchId)
          .map((assignment) => [assignment.portId, assignment]),
      );
      for (const port of await managedSwitch.getPorts()) {
        const assignment = assignments.get(port.id);
        const team = assignment?.teamNetworkId
          ? teams.get(assignment.teamNetworkId)
          : undefined;
        if (assignment?.role === "ap-trunk")
          await managedSwitch.setTrunkVlans(
            port.id,
            [...teams.values()].map((item) => item.vlanId),
            config.managementVlan,
          );
        else
          await managedSwitch.setAccessVlan(
            port.id,
            team?.vlanId ??
              (assignment?.role === "management" ||
              assignment?.role === "server"
                ? config.managementVlan
                : config.onboardingVlan),
          );
        await managedSwitch.setPortEnabled(port.id, true);
        await managedSwitch.clearMacsOnPort?.(port.id);
        if (managedSwitch === this.mockSwitch)
          this.mockSwitch.simulateLink(port.id, false);
      }
    }
    for (const [
      accessPointId,
      accessPoint,
    ] of this.hardware.listAccessPoints()) {
      const capabilities = await accessPoint.getCapabilities();
      for (const slotId of capabilities.slotIds)
        await accessPoint.clearTeam(slotId);
      for (const team of teams.values()) {
        if (team.accessPointId !== accessPointId || !team.accessPointSlot)
          continue;
        const wpaKey =
          team.credentialRef && this.credentials
            ? await this.credentials.get(team.credentialRef)
            : undefined;
        await accessPoint.configureTeam(team.accessPointSlot, {
          teamNumber: team.teamNumber,
          ssid: `FRC-${team.teamNumber}`,
          vlanId: team.vlanId,
          ...(wpaKey ? { wpaKey } : {}),
        });
      }
    }
  }

  async reset(
    mode: "hardware-to-desired" | "seeded-demo" = "hardware-to-desired",
  ): Promise<SimulationState> {
    // Reset is a recovery action, so it must clear simulated outages first.
    this.mockSwitch.setAvailable(true);
    this.mockSwitch.clearFailures?.();
    this.mockAccessPoint.setAvailable(true);
    this.mockAccessPoint.clearFailures?.();
    if (mode === "seeded-demo") {
      if (!this.resetSeededDemo)
        throw new DomainError(
          "CONFLICT",
          "Seeded demo reset is not available",
          409,
        );
      await this.resetSeededDemo();
    } else await this.resetHardwareToDesired();
    return this.state();
  }

  private requireSwitch(switchId: string): ManagedSwitch {
    try {
      return this.hardware.getSwitch(switchId);
    } catch {
      throw new DomainError(
        "NOT_FOUND",
        `Switch ${switchId} was not found`,
        404,
      );
    }
  }
  private requireAccessPoint(accessPointId: string): AccessPoint {
    try {
      return this.hardware.getAccessPoint(accessPointId);
    } catch {
      throw new DomainError(
        "NOT_FOUND",
        `Access point ${accessPointId} was not found`,
        404,
      );
    }
  }
  private publicStation<T extends { configuration?: { wpaKey?: string } }>(
    status: T,
  ): T {
    if (!status.configuration) return status;
    return {
      ...status,
      configuration: { ...status.configuration, wpaKey: undefined },
    };
  }
}
