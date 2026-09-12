import type { FieldRepository } from "@repo/db";
import { DomainError } from "./errors.js";

export class VlanAllocator {
  constructor(private readonly repository: FieldRepository) {}

  allocate(): number {
    const config = this.repository.getConfig();
    const allocated = new Set(this.repository.listAllocatedVlans());
    const reserved = new Set([config.managementVlan, config.onboardingVlan]);
    for (
      let vlanId = config.teamVlanStart;
      vlanId <= config.teamVlanEnd;
      vlanId += 1
    ) {
      if (!reserved.has(vlanId) && !allocated.has(vlanId)) return vlanId;
    }
    throw new DomainError(
      "CONFLICT",
      "The configured team VLAN pool is exhausted",
      409,
    );
  }

  /** Persistence owns allocations. Removing a team makes its VLAN eligible for deterministic reuse. */
  release(vlanId: number): void {
    const config = this.repository.getConfig();
    if (vlanId === config.managementVlan || vlanId === config.onboardingVlan) {
      throw new DomainError(
        "CONFLICT",
        `VLAN ${vlanId} is reserved and cannot be released`,
        409,
      );
    }
  }
}
