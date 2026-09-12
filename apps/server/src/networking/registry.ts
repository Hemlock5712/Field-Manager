import type { AccessPoint } from "@repo/ap";
import type { ManagedSwitch } from "@repo/switch";
import { DomainError } from "./errors.js";

export class HardwareRegistry {
  private readonly switches = new Map<string, ManagedSwitch>();
  private readonly accessPoints = new Map<string, AccessPoint>();

  registerSwitch(id: string, managedSwitch: ManagedSwitch): void {
    this.switches.set(id, managedSwitch);
  }
  registerAccessPoint(id: string, accessPoint: AccessPoint): void {
    this.accessPoints.set(id, accessPoint);
  }
  listSwitches(): Array<[string, ManagedSwitch]> {
    return [...this.switches.entries()];
  }
  listAccessPoints(): Array<[string, AccessPoint]> {
    return [...this.accessPoints.entries()];
  }

  getSwitch(id: string): ManagedSwitch {
    const value = this.switches.get(id);
    if (!value)
      throw new DomainError("NOT_FOUND", `Switch ${id} was not found`, 404);
    return value;
  }

  getAccessPoint(id: string): AccessPoint {
    const value = this.accessPoints.get(id);
    if (!value)
      throw new DomainError(
        "NOT_FOUND",
        `Access point ${id} was not found`,
        404,
      );
    return value;
  }
}
