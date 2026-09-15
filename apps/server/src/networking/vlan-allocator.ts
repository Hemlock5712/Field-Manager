import type { FieldRepository } from "@repo/db";
import { DomainError } from "./errors.js";

export class VlanAllocator {
  constructor(private readonly repository: FieldRepository) {}

  allocate(supportedVlans?: readonly number[]): number {
    const config = this.repository.getConfig();
    const allocated = new Set(this.repository.listAllocatedVlans());
    const reserved = new Set([config.managementVlan, config.onboardingVlan]);
    const candidates = supportedVlans
      ? [...new Set(supportedVlans)].sort((left, right) => left - right)
      : Array.from(
          { length: config.teamVlanEnd - config.teamVlanStart + 1 },
          (_, index) => config.teamVlanStart + index,
        );
    for (const vlanId of candidates) {
      if (vlanId < config.teamVlanStart || vlanId > config.teamVlanEnd)
        continue;
      if (!reserved.has(vlanId) && !allocated.has(vlanId)) return vlanId;
    }
    throw new DomainError(
      "CONFLICT",
      supportedVlans
        ? "No VLAN supported by the selected access-point slot is available in the configured team VLAN pool"
        : "The configured team VLAN pool is exhausted",
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
