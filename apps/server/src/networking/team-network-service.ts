import type { AccessPoint, AccessPointStationStatus } from "@repo/ap";
import type { CredentialStore, TeamNetwork } from "@repo/core";
import type { FieldRepository, TeamNetworkRecord } from "@repo/db";
import { DomainError } from "./errors.js";
import { toTeamNetwork } from "./mappers.js";
import { PortAssignmentService } from "./port-assignment-service.js";
import { HardwareRegistry } from "./registry.js";
import { VlanAllocator } from "./vlan-allocator.js";

export interface CreateTeamNetworkInput {
  teamNumber: number;
  accessPointId?: string;
  accessPointSlot?: string;
  ssid?: string;
  wpaKey?: string;
}

export class TeamNetworkService {
  constructor(
    private readonly repository: FieldRepository,
    private readonly vlanAllocator: VlanAllocator,
    private readonly hardware: HardwareRegistry,
    private readonly credentials: CredentialStore,
    private readonly ports: PortAssignmentService,
  ) {}

  list(): TeamNetwork[] {
    return this.repository.listTeamNetworks().map(toTeamNetwork);
  }
  get(id: string): TeamNetwork {
    const value = this.repository.getTeamNetwork(id);
    if (!value)
      throw new DomainError(
        "NOT_FOUND",
        `Team network ${id} was not found`,
        404,
      );
    return toTeamNetwork(value);
  }

  async create(input: CreateTeamNetworkInput): Promise<TeamNetwork> {
    if (this.repository.getTeamNetworkByNumber(input.teamNumber)) {
      throw new DomainError(
        "CONFLICT",
        `Team ${input.teamNumber} already has a network`,
        409,
      );
    }
    const selected = await this.selectStation(
      input.accessPointId,
      input.accessPointSlot,
    );
    const now = new Date().toISOString();
    const id = `team-${input.teamNumber}-${crypto.randomUUID().slice(0, 8)}`;
    const credentialRef = `team/${id}/wireless-key`;
    const wpaKey =
      input.wpaKey ??
      `FRC-${input.teamNumber}-${crypto.randomUUID().slice(0, 8)}`;
    await this.credentials.put(credentialRef, wpaKey);

    const record = this.repository.runInTransaction(() => {
      const vlanId = this.vlanAllocator.allocate();
      const network: TeamNetworkRecord = {
        id,
        teamNumber: input.teamNumber,
        vlanId,
        accessPointId: selected.id,
        accessPointSlot: selected.slotId,
        credentialRef,
        status: "provisioning",
        createdAt: now,
        updatedAt: now,
      };
      this.repository.insertTeamNetwork(network);
      return network;
    });

    try {
      await selected.accessPoint.configureTeam(selected.slotId, {
        teamNumber: input.teamNumber,
        ssid: input.ssid ?? `FRC-${input.teamNumber}`,
        wpaKey,
        vlanId: record.vlanId,
      });
      await this.syncAccessPointTrunks();
      const updated = {
        ...record,
        status: "waiting-for-robot" as const,
        updatedAt: new Date().toISOString(),
      };
      this.repository.updateTeamNetwork(updated);
      return toTeamNetwork(updated);
    } catch (error) {
      const failed = {
        ...record,
        status: "error" as const,
        statusMessage: String(error),
        updatedAt: new Date().toISOString(),
      };
      this.repository.updateTeamNetwork(failed);
      throw new DomainError(
        "HARDWARE_WRITE_FAILED",
        "The network was allocated, but AP configuration failed",
        502,
        {
          teamNetworkId: id,
          persisted: true,
          cause: String(error),
        },
      );
    }
  }

  async remove(id: string): Promise<void> {
    const network = this.repository.getTeamNetwork(id);
    if (!network)
      throw new DomainError(
        "NOT_FOUND",
        `Team network ${id} was not found`,
        404,
      );
    try {
      for (const assignment of this.ports.listForTeam(id)) {
        await this.ports.returnToOnboarding(
          assignment.switchId,
          assignment.portId,
          false,
        );
      }
      if (network.accessPointId && network.accessPointSlot) {
        await this.hardware
          .getAccessPoint(network.accessPointId)
          .clearTeam(network.accessPointSlot);
      }
    } catch (error) {
      this.repository.updateTeamNetwork({
        ...network,
        status: "error",
        statusMessage: `Disconnect failed: ${String(error)}`,
        updatedAt: new Date().toISOString(),
      });
      throw new DomainError(
        "HARDWARE_WRITE_FAILED",
        "Team removal stopped because hardware could not be returned safely",
        502,
        {
          teamNetworkId: id,
          cause: String(error),
        },
      );
    }
    this.repository.runInTransaction(() => {
      this.repository.clearTeamFromPorts(id);
      this.repository.deleteTeamNetwork(id);
    });
    await this.syncAccessPointTrunks();
    if (network.credentialRef)
      await this.credentials.delete(network.credentialRef);
  }

  async refreshStatuses(): Promise<TeamNetwork[]> {
    for (const record of this.repository.listTeamNetworks()) {
      if (!record.accessPointId || !record.accessPointSlot) continue;
      try {
        const status = await this.hardware
          .getAccessPoint(record.accessPointId)
          .getStationStatus(record.accessPointSlot);
        const next =
          status.state === "associated"
            ? "online"
            : status.state === "configured"
              ? "waiting-for-robot"
              : "offline";
        if (record.status !== next)
          this.repository.updateTeamNetwork({
            ...record,
            status: next,
            statusMessage: undefined,
            updatedAt: new Date().toISOString(),
          });
      } catch (error) {
        this.repository.updateTeamNetwork({
          ...record,
          status: "error",
          statusMessage: String(error),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return this.list();
  }

  private async selectStation(
    requestedApId?: string,
    requestedSlot?: string,
  ): Promise<{ id: string; slotId: string; accessPoint: AccessPoint }> {
    const candidates = requestedApId
      ? [
          [requestedApId, this.hardware.getAccessPoint(requestedApId)] as [
            string,
            AccessPoint,
          ],
        ]
      : this.hardware.listAccessPoints();
    for (const [id, accessPoint] of candidates) {
      let slotIds: string[];
      try {
        slotIds = requestedSlot
          ? [requestedSlot]
          : (await accessPoint.getCapabilities()).slotIds;
      } catch (error) {
        if (requestedApId)
          throw new DomainError(
            "HARDWARE_UNAVAILABLE",
            `Access point ${id} is unavailable`,
            502,
            { cause: String(error) },
          );
        continue;
      }
      for (const slotId of slotIds) {
        let status: AccessPointStationStatus;
        try {
          status = await accessPoint.getStationStatus(slotId);
        } catch (error) {
          if (requestedApId) {
            throw new DomainError(
              "HARDWARE_UNAVAILABLE",
              `Access point ${id} is unavailable`,
              502,
              {
                slotId,
                cause: String(error),
              },
            );
          }
          continue;
        }
        if (status.state === "available") return { id, slotId, accessPoint };
      }
    }
    throw new DomainError(
      "NO_AP_CAPACITY",
      "No access point station is currently available",
      409,
    );
  }

  private async syncAccessPointTrunks(): Promise<void> {
    const config = this.repository.getConfig();
    const teamVlans = this.repository.listAllocatedVlans();
    for (const assignment of this.repository.listPortAssignments()) {
      if (assignment.role !== "ap-trunk") continue;
      await this.hardware
        .getSwitch(assignment.switchId)
        .setTrunkVlans(assignment.portId, teamVlans, config.managementVlan);
    }
  }
}
