import type { DhcpLease, DhcpLeaseProvider } from "@repo/core";
import type { FieldRepository } from "@repo/db";
import { DomainError } from "./errors.js";
import { PortAssignmentService } from "./port-assignment-service.js";
import { HardwareRegistry } from "./registry.js";

export interface PortalSession {
  ip: string;
  lease?: DhcpLease;
  switchId?: string;
  portId?: string;
  ready: boolean;
  reason?: string;
}

export class CaptivePortalService {
  constructor(
    private readonly repository: FieldRepository,
    private readonly leases: DhcpLeaseProvider,
    private readonly hardware: HardwareRegistry,
    private readonly ports: PortAssignmentService,
  ) {}

  async getSession(ip: string): Promise<PortalSession> {
    const lease = await this.leases.getLeaseByIp(ip);
    if (!lease)
      return {
        ip,
        ready: false,
        reason: "No DHCP lease matches this client address",
      };
    if (lease.expiresAt && Date.parse(lease.expiresAt) <= Date.now()) {
      return {
        ip,
        lease,
        ready: false,
        reason: "The matching DHCP lease is stale",
      };
    }
    for (const [switchId, managedSwitch] of this.hardware.listSwitches()) {
      try {
        const portId = await managedSwitch.findPortByMac(lease.mac);
        if (portId) return { ip, lease, switchId, portId, ready: true };
      } catch {
        // Continue in multi-switch installations; connect reports a useful aggregate failure.
      }
    }
    return {
      ip,
      lease,
      ready: false,
      reason: "The client MAC is not present in any switch forwarding table",
    };
  }

  async connect(
    ip: string,
    teamNumber: number,
  ): Promise<{
    teamNetworkId: string;
    switchId: string;
    portId: string;
    vlanId: number;
  }> {
    const network = this.repository.getTeamNetworkByNumber(teamNumber);
    if (!network)
      throw new DomainError(
        "NOT_FOUND",
        `Team ${teamNumber} has not been configured yet`,
        404,
      );
    const lease = await this.leases.getLeaseByIp(ip);
    if (!lease)
      throw new DomainError(
        "UNKNOWN_CLIENT",
        "Unable to match your IP address to a DHCP lease",
        404,
        { ip },
      );
    if (lease.expiresAt && Date.parse(lease.expiresAt) <= Date.now()) {
      throw new DomainError(
        "STALE_LEASE",
        "The matching DHCP lease has expired; reconnect and try again",
        409,
        { ip, mac: lease.mac },
      );
    }

    let hardwareErrors = 0;
    for (const [switchId, managedSwitch] of this.hardware.listSwitches()) {
      let portId: string | null;
      try {
        portId = await managedSwitch.findPortByMac(lease.mac);
      } catch {
        hardwareErrors += 1;
        continue;
      }
      if (!portId) continue;
      await this.ports.assignToTeam(switchId, portId, network.id, {
        bounce: true,
      });
      return {
        teamNetworkId: network.id,
        switchId,
        portId,
        vlanId: network.vlanId,
      };
    }
    if (
      hardwareErrors === this.hardware.listSwitches().length &&
      hardwareErrors > 0
    ) {
      throw new DomainError(
        "HARDWARE_UNAVAILABLE",
        "No managed switch could complete the client lookup",
        502,
      );
    }
    throw new DomainError(
      "UNKNOWN_CLIENT",
      "Unable to determine the physical switch port for this device",
      404,
      { mac: lease.mac },
    );
  }
}
