import type { PortAssignment, PortRole } from "@repo/core";
import type { FieldRepository } from "@repo/db";
import type { ManagedSwitch, SwitchPort } from "@repo/switch";
import { DomainError } from "./errors.js";
import { HardwareRegistry } from "./registry.js";

function toAssignment(
  record: ReturnType<FieldRepository["getPortAssignment"]>,
): PortAssignment | undefined {
  if (!record) return undefined;
  return {
    switchId: record.switchId,
    portId: record.portId,
    ...(record.teamNetworkId ? { teamNetworkId: record.teamNetworkId } : {}),
    role: record.role,
    ...(record.label ? { label: record.label } : {}),
    updatedAt: record.updatedAt,
  };
}

export class PortAssignmentService {
  constructor(
    private readonly repository: FieldRepository,
    private readonly hardware: HardwareRegistry,
  ) {}

  async assignToTeam(
    switchId: string,
    portId: string,
    teamNetworkId: string,
    options: { bounce?: boolean; label?: string } = {},
  ): Promise<PortAssignment> {
    const team = this.repository.getTeamNetwork(teamNetworkId);
    if (!team)
      throw new DomainError(
        "NOT_FOUND",
        `Team network ${teamNetworkId} was not found`,
        404,
      );
    const managedSwitch = this.hardware.getSwitch(switchId);
    const port = await this.getPort(managedSwitch, portId);
    const existing = this.repository.getPortAssignment(switchId, portId);
    const role = existing?.role ?? port.role;
    if (role !== "client" && role !== "unused") {
      throw new DomainError(
        "RESERVED_PORT",
        `Port ${portId} is reserved for role ${role}`,
        409,
        { role },
      );
    }

    const config = this.repository.getConfig();
    const previousVlan = port.mode === "access" ? port.accessVlan : undefined;
    try {
      await managedSwitch.setAccessVlan(portId, team.vlanId);
    } catch (error) {
      throw this.hardwareWriteError("assign VLAN", switchId, portId, error);
    }

    try {
      this.repository.upsertPortAssignment({
        switchId,
        portId,
        teamNetworkId,
        role: "client",
        label: options.label ?? existing?.label,
      });
    } catch (error) {
      try {
        await managedSwitch.setAccessVlan(
          portId,
          previousVlan ?? config.onboardingVlan,
        );
      } catch (rollbackError) {
        throw new DomainError(
          "STATE_DIVERGED",
          "The VLAN changed, persistence failed, and rollback also failed",
          500,
          {
            switchId,
            portId,
            cause: String(error),
            rollbackCause: String(rollbackError),
          },
        );
      }
      throw new DomainError(
        "HARDWARE_WRITE_FAILED",
        "Persistence failed; the switch change was rolled back",
        500,
        {
          switchId,
          portId,
          cause: String(error),
        },
      );
    }

    if (options.bounce ?? true) {
      try {
        await managedSwitch.bouncePort(portId, config.portBounceDelayMs);
      } catch (error) {
        throw new DomainError(
          "HARDWARE_WRITE_FAILED",
          "VLAN assignment succeeded, but the port could not be bounced",
          502,
          {
            switchId,
            portId,
            persisted: true,
            cause: String(error),
          },
        );
      }
    }
    return toAssignment(this.repository.getPortAssignment(switchId, portId))!;
  }

  async returnToOnboarding(
    switchId: string,
    portId: string,
    bounce = true,
  ): Promise<PortAssignment> {
    const managedSwitch = this.hardware.getSwitch(switchId);
    const port = await this.getPort(managedSwitch, portId);
    const existing = this.repository.getPortAssignment(switchId, portId);
    const role = existing?.role ?? port.role;
    if (role !== "client" && role !== "unused") {
      throw new DomainError(
        "RESERVED_PORT",
        `Port ${portId} is reserved for role ${role}`,
        409,
        { role },
      );
    }
    const config = this.repository.getConfig();
    try {
      await managedSwitch.setAccessVlan(portId, config.onboardingVlan);
      // A port may have been administratively disabled while assigned to a team.
      // Returning it to onboarding is a complete safe reset: enable it and flush
      // forwarding entries so a new DHCP lease is learned on the onboarding VLAN.
      await managedSwitch.setPortEnabled(portId, true);
      await managedSwitch.clearMacsOnPort?.(portId);
    } catch (error) {
      throw this.hardwareWriteError(
        "return port to onboarding",
        switchId,
        portId,
        error,
      );
    }
    this.repository.upsertPortAssignment({
      switchId,
      portId,
      role: "client",
      label: existing?.label,
    });
    if (bounce)
      await managedSwitch.bouncePort(portId, config.portBounceDelayMs);
    return toAssignment(this.repository.getPortAssignment(switchId, portId))!;
  }

  async setEnabled(
    switchId: string,
    portId: string,
    enabled: boolean,
  ): Promise<void> {
    const managedSwitch = this.hardware.getSwitch(switchId);
    await this.getPort(managedSwitch, portId);
    try {
      await managedSwitch.setPortEnabled(portId, enabled);
    } catch (error) {
      throw this.hardwareWriteError(
        enabled ? "enable port" : "disable port",
        switchId,
        portId,
        error,
      );
    }
  }

  async bounce(switchId: string, portId: string): Promise<void> {
    const managedSwitch = this.hardware.getSwitch(switchId);
    await this.getPort(managedSwitch, portId);
    try {
      await managedSwitch.bouncePort(
        portId,
        this.repository.getConfig().portBounceDelayMs,
      );
    } catch (error) {
      throw this.hardwareWriteError("bounce port", switchId, portId, error);
    }
  }

  async setRole(
    switchId: string,
    portId: string,
    role: PortRole,
    label?: string,
  ): Promise<PortAssignment> {
    const managedSwitch = this.hardware.getSwitch(switchId);
    await this.getPort(managedSwitch, portId);
    const existing = this.repository.getPortAssignment(switchId, portId);
    if (existing?.teamNetworkId && role !== "client") {
      throw new DomainError(
        "CONFLICT",
        "Return the port to onboarding before changing its reserved role",
        409,
      );
    }
    const config = this.repository.getConfig();
    try {
      if (role === "ap-trunk") {
        await managedSwitch.setTrunkVlans(
          portId,
          this.repository.listAllocatedVlans(),
          config.managementVlan,
        );
      } else {
        const vlanId =
          role === "client" || role === "unused"
            ? config.onboardingVlan
            : config.managementVlan;
        await managedSwitch.setAccessVlan(portId, vlanId);
      }
    } catch (error) {
      throw this.hardwareWriteError(
        "change port role",
        switchId,
        portId,
        error,
      );
    }
    this.repository.upsertPortAssignment({
      switchId,
      portId,
      teamNetworkId: existing?.teamNetworkId,
      role,
      label,
    });
    return toAssignment(this.repository.getPortAssignment(switchId, portId))!;
  }

  listForTeam(teamNetworkId: string): PortAssignment[] {
    return this.repository
      .listPortAssignments()
      .filter((item) => item.teamNetworkId === teamNetworkId)
      .map((item) => toAssignment(item)!);
  }

  private async getPort(
    managedSwitch: ManagedSwitch,
    portId: string,
  ): Promise<SwitchPort> {
    try {
      return await managedSwitch.getPort(portId);
    } catch (error) {
      throw new DomainError(
        "INVALID_PORT",
        `Unable to read port ${portId}`,
        404,
        { cause: String(error) },
      );
    }
  }

  private hardwareWriteError(
    action: string,
    switchId: string,
    portId: string,
    error: unknown,
  ): DomainError {
    return new DomainError(
      "HARDWARE_WRITE_FAILED",
      `Unable to ${action}`,
      502,
      { switchId, portId, cause: String(error) },
    );
  }
}
