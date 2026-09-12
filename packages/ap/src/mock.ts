import {
  AccessPointOperationError,
  AccessPointSlotNotFoundError,
  AccessPointUnavailableError,
  type AccessPoint,
  type AccessPointCapabilities,
  type AccessPointInfo,
  type AccessPointStation,
  type AccessPointStationStatus,
  type TeamWirelessConfiguration,
} from "./index.js";
export type MockApFailureOperation =
  | "getInfo"
  | "getCapabilities"
  | "getStations"
  | "configureTeam"
  | "clearTeam"
  | "getStationStatus";
export interface MockAssociation {
  macAddress: string;
  signalStrengthDbm?: number;
}
export interface MockAccessPointOptions {
  slotIds?: string[];
  info?: Partial<AccessPointInfo> & Pick<AccessPointInfo, "id" | "name">;
}
interface Slot {
  configuration?: TeamWirelessConfiguration;
  association?: MockAssociation;
}
const normalizeMac = (mac: string): string => {
  const normalized = mac.trim().toUpperCase().replaceAll("-", ":");
  if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(normalized))
    throw new TypeError(`Invalid MAC address: ${mac}`);
  return normalized;
};
const validVlan = (vlan: number): void => {
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)
    throw new RangeError(`VLAN must be an integer between 1 and 4094: ${vlan}`);
};

/** Complete deterministic six-slot AP simulator. Slot names are implementation details, not core concepts. */
export class MockAccessPoint implements AccessPoint {
  readonly info: AccessPointInfo;
  readonly capabilities: AccessPointCapabilities;
  private readonly slots = new Map<string, Slot>();
  private readonly failures = new Map<MockApFailureOperation, Error>();
  private available = true;
  constructor(options: MockAccessPointOptions = {}) {
    const slotIds =
      options.slotIds ?? Array.from({ length: 6 }, (_, i) => `slot-${i + 1}`);
    if (
      slotIds.length === 0 ||
      new Set(slotIds).size !== slotIds.length ||
      slotIds.some((slotId) => !slotId.trim())
    )
      throw new RangeError("slotIds must be unique and non-empty");
    this.info = {
      id: options.info?.id ?? "mock-ap",
      name: options.info?.name ?? "Mock VH-113",
      manufacturer: options.info?.manufacturer ?? "mock",
      model: options.info?.model ?? "simulated-vh-113",
      firmwareVersion: options.info?.firmwareVersion ?? "simulated",
      managementAddress: options.info?.managementAddress ?? "127.0.0.2",
    };
    this.capabilities = {
      maxStations: slotIds.length,
      slotIds: [...slotIds],
      supportsVlanAssignment: true,
      supportsAssociationStatus: true,
    };
    slotIds.forEach((slotId) => this.slots.set(slotId, {}));
  }
  private before(operation: MockApFailureOperation): void {
    if (!this.available)
      throw new AccessPointUnavailableError(`${this.info.name} is unavailable`);
    const failure = this.failures.get(operation);
    if (failure) throw new AccessPointOperationError(failure.message);
  }
  private slot(slotId: string): Slot {
    const slot = this.slots.get(slotId);
    if (!slot)
      throw new AccessPointSlotNotFoundError(
        `Unknown access-point slot: ${slotId}`,
      );
    return slot;
  }
  getInfo(): Promise<AccessPointInfo> {
    this.before("getInfo");
    return Promise.resolve({ ...this.info });
  }
  getCapabilities(): Promise<AccessPointCapabilities> {
    this.before("getCapabilities");
    return Promise.resolve({
      ...this.capabilities,
      slotIds: [...this.capabilities.slotIds],
    });
  }
  getStations(): Promise<AccessPointStation[]> {
    this.before("getStations");
    const stations: AccessPointStation[] = [];
    for (const [slotId, slot] of this.slots)
      if (slot.configuration && slot.association)
        stations.push(this.station(slotId, slot));
    return Promise.resolve(stations);
  }
  async configureTeam(
    slotId: string,
    configuration: TeamWirelessConfiguration,
  ): Promise<void> {
    this.before("configureTeam");
    this.slot(slotId);
    if (
      !Number.isInteger(configuration.teamNumber) ||
      configuration.teamNumber < 1
    )
      throw new RangeError("teamNumber must be positive");
    if (!configuration.ssid.trim()) throw new Error("SSID cannot be empty");
    validVlan(configuration.vlanId);
    this.slots.get(slotId)!.configuration = { ...configuration };
  }
  async clearTeam(slotId: string): Promise<void> {
    this.before("clearTeam");
    const slot = this.slot(slotId);
    slot.configuration = undefined;
    slot.association = undefined;
  }
  getStationStatus(slotId: string): Promise<AccessPointStationStatus> {
    this.before("getStationStatus");
    const slot = this.slot(slotId);
    if (!slot.configuration)
      return Promise.resolve({ slotId, state: "available" });
    if (!slot.association)
      return Promise.resolve({
        slotId,
        state: "configured",
        configuration: { ...slot.configuration },
      });
    return Promise.resolve({
      slotId,
      state: "associated",
      configuration: { ...slot.configuration },
      station: this.station(slotId, slot),
    });
  }
  private station(slotId: string, slot: Slot): AccessPointStation {
    const configuration = slot.configuration!;
    const association = slot.association!;
    return {
      slotId,
      macAddress: association.macAddress,
      teamNumber: configuration.teamNumber,
      connected: true,
      signalStrengthDbm: association.signalStrengthDbm,
      vlanId: configuration.vlanId,
      ssid: configuration.ssid,
    };
  }
  setAvailable(available: boolean): void {
    this.available = available;
  }
  isAvailable(): boolean {
    return this.available;
  }
  setOperationFailure(operation: MockApFailureOperation, error?: Error): void {
    if (error) this.failures.set(operation, error);
    else this.failures.delete(operation);
  }
  setFailure(operation: MockApFailureOperation, error?: Error): void {
    this.setOperationFailure(operation, error);
  }
  clearFailures(): void {
    this.failures.clear();
  }
  simulateAssociation(slotId: string, association: MockAssociation): void {
    const slot = this.slot(slotId);
    if (!slot.configuration)
      throw new Error(`Slot ${slotId} has no team configuration`);
    slot.association = {
      macAddress: normalizeMac(association.macAddress),
      signalStrengthDbm: association.signalStrengthDbm ?? -55,
    };
  }
  associate(slotId: string, association: MockAssociation): void {
    this.simulateAssociation(slotId, association);
  }
  simulateDisassociation(slotId: string): void {
    this.slot(slotId).association = undefined;
  }
  disassociate(slotId: string): void {
    this.simulateDisassociation(slotId);
  }
  simulateSignal(slotId: string, signalStrengthDbm: number): void {
    const association = this.slot(slotId).association;
    if (!association) throw new Error(`Slot ${slotId} is not associated`);
    association.signalStrengthDbm = signalStrengthDbm;
  }
}

/** Descriptive alias for demo code that wants to make the simulated hardware explicit. */
export class MockVH113AccessPoint extends MockAccessPoint {}
