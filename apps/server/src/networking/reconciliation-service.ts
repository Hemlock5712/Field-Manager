import type { NetworkHealthIssue, NetworkHealthReport } from "@repo/core";
import type { FieldRepository } from "@repo/db";
import { HardwareRegistry } from "./registry.js";

export class NetworkHealthService {
  constructor(
    private readonly repository: FieldRepository,
    private readonly hardware: HardwareRegistry,
  ) {}

  async inspect(): Promise<NetworkHealthReport> {
    const issues: NetworkHealthIssue[] = [];
    const config = this.repository.getConfig();
    const teams = new Map(
      this.repository.listTeamNetworks().map((team) => [team.id, team]),
    );
    const assignmentsBySwitch = new Map<
      string,
      ReturnType<FieldRepository["listPortAssignments"]>
    >();

    for (const assignment of this.repository.listPortAssignments()) {
      const assignments = assignmentsBySwitch.get(assignment.switchId) ?? [];
      assignments.push(assignment);
      assignmentsBySwitch.set(assignment.switchId, assignments);
    }

    for (const [switchId, assignments] of assignmentsBySwitch) {
      let ports;
      try {
        ports = await this.hardware.getSwitch(switchId).getPorts();
      } catch (error) {
        for (const assignment of assignments)
          issues.push({
            kind: "hardware-unavailable",
            switchId,
            portId: assignment.portId,
            message: `Could not inspect ${switchId} port ${assignment.portId}: ${String(error)}`,
          });
        continue;
      }

      const portsById = new Map(ports.map((port) => [port.id, port]));
      for (const assignment of assignments) {
        const port = portsById.get(assignment.portId);
        if (!port) {
          issues.push({
            kind: "hardware-unavailable",
            switchId,
            portId: assignment.portId,
            message: `Could not inspect ${switchId} port ${assignment.portId}: port was not returned by the switch`,
          });
          continue;
        }
        if (assignment.role === "client" || assignment.role === "unused") {
          const team = assignment.teamNetworkId
            ? teams.get(assignment.teamNetworkId)
            : undefined;
          const expected = team?.vlanId ?? config.onboardingVlan;
          if (port.mode !== "access" || port.accessVlan !== expected) {
            issues.push({
              kind: "switch-port-drift",
              switchId,
              portId: assignment.portId,
              ...(team ? { teamNetworkId: team.id } : {}),
              message: `Port ${assignment.portId} expected access VLAN ${expected}; actual ${port.mode === "access" ? `VLAN ${port.accessVlan ?? "unset"}` : "trunk"}`,
            });
          }
        } else if (assignment.role === "ap-trunk") {
          const expectedVlans = [...teams.values()]
            .map((team) => team.vlanId)
            .sort((left, right) => left - right);
          const actualVlans = [...(port.taggedVlans ?? [])].sort(
            (left, right) => left - right,
          );
          if (
            port.mode !== "trunk" ||
            port.nativeVlan !== config.managementVlan ||
            expectedVlans.join(",") !== actualVlans.join(",")
          ) {
            issues.push({
              kind: "switch-port-drift",
              switchId,
              portId: assignment.portId,
              message: `AP trunk ${assignment.portId} expected tagged VLANs [${expectedVlans.join(", ")}] with native VLAN ${config.managementVlan}`,
            });
          }
        }
      }
    }

    for (const team of teams.values()) {
      if (!team.accessPointId || !team.accessPointSlot) continue;
      try {
        const status = await this.hardware
          .getAccessPoint(team.accessPointId)
          .getStationStatus(team.accessPointSlot);
        const actual = status.configuration;
        if (
          !actual ||
          actual.teamNumber !== team.teamNumber ||
          actual.ssid !== (team.wirelessSsid ?? `FRC-${team.teamNumber}`) ||
          actual.vlanId !== team.vlanId
        ) {
          issues.push({
            kind: "access-point-drift",
            accessPointId: team.accessPointId,
            slotId: team.accessPointSlot,
            teamNetworkId: team.id,
            message: `Team ${team.teamNumber} expects VLAN ${team.vlanId} in AP slot ${team.accessPointSlot}; actual ${actual ? `Team ${actual.teamNumber}, VLAN ${actual.vlanId}` : "unconfigured"}`,
          });
        }
      } catch (error) {
        issues.push({
          kind: "hardware-unavailable",
          accessPointId: team.accessPointId,
          slotId: team.accessPointSlot,
          teamNetworkId: team.id,
          message: `Could not inspect AP slot ${team.accessPointSlot}: ${String(error)}`,
        });
      }
    }
    return {
      healthy: issues.length === 0,
      checkedAt: new Date().toISOString(),
      issues,
    };
  }
}
