import {
  SwitchOperationError,
  SwitchPortNotFoundError,
  SwitchUnavailableError,
  type MacTableEntry,
  type ManagedSwitch,
  type SwitchCapabilities,
  type SwitchInfo,
  type SwitchPort,
  type SwitchPortRole,
} from "./index.js";

export type MockSwitchFailureOperation =
  | "getInfo"
  | "getCapabilities"
  | "getPorts"
  | "getPort"
  | "setAccessVlan"
  | "setTrunkVlans"
  | "setPortEnabled"
  | "bouncePort"
  | "getMacTable"
  | "getMacsOnPort"
  | "findPortByMac"
  | "resetPort"
  | "clearMacsOnPort";
export interface MockSwitchPort extends SwitchPort {
  initialAccessVlan: number;
}
export interface MockManagedSwitchOptions {
  portCount?: number;
  managementVlan?: number;
  onboardingVlan?: number;
  config?: { managementVlan?: number; onboardingVlan?: number };
  info?: Partial<SwitchInfo> & Pick<SwitchInfo, "id" | "name">;
  clientPorts?: string[];
  apTrunkPorts?: string[];
  initialPorts?: Partial<SwitchPort>[];
  defaultSpeedMbps?: number;
  bounceDelayMs?: number;
}

const validVlan = (vlan: number): void => {
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)
    throw new RangeError(`VLAN must be an integer between 1 and 4094: ${vlan}`);
};
const normalizeMac = (mac: string): string => {
  const normalized = mac.trim().toUpperCase().replaceAll("-", ":");
  if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(normalized))
    throw new TypeError(`Invalid MAC address: ${mac}`);
  return normalized;
};

export class MockManagedSwitch implements ManagedSwitch {
  readonly info: SwitchInfo;
  readonly capabilities: SwitchCapabilities;
  private readonly ports = new Map<string, MockSwitchPort>();
  private readonly macs = new Map<string, MacTableEntry>();
  private readonly failures = new Map<MockSwitchFailureOperation, Error>();
  private available = true;
  private readonly defaultBounceDelayMs: number;
  constructor(options: MockManagedSwitchOptions = {}) {
    const count = options.portCount ?? 24;
    if (!Number.isInteger(count) || count < 1)
      throw new RangeError("portCount must be positive");
    const managementVlan =
      options.managementVlan ?? options.config?.managementVlan ?? 100;
    const onboardingVlan =
      options.onboardingVlan ?? options.config?.onboardingVlan ?? 999;
    validVlan(managementVlan);
    validVlan(onboardingVlan);
    this.defaultBounceDelayMs = options.bounceDelayMs ?? 0;
    this.info = {
      id: options.info?.id ?? "mock-switch",
      name: options.info?.name ?? "Mock Practice Switch",
      manufacturer: options.info?.manufacturer ?? "mock",
      model: options.info?.model ?? "simulated-24p",
      firmwareVersion: options.info?.firmwareVersion ?? "simulated",
      managementAddress: options.info?.managementAddress ?? "127.0.0.1",
    };
    this.capabilities = {
      maxPorts: count,
      supportsAccessVlans: true,
      supportsTrunks: true,
      supportsPortBounce: true,
      supportsMacTable: true,
      supportsPortEnable: true,
    };
    const clientPorts = new Set(
      options.clientPorts ??
        Array.from({ length: count }, (_, i) => String(i + 1)),
    );
    const apPorts = new Set(options.apTrunkPorts ?? []);
    for (let i = 1; i <= count; i += 1) {
      const id = String(i);
      const override = options.initialPorts?.find(
        (candidate) => candidate.id === id,
      );
      const role =
        override?.role ??
        (apPorts.has(id)
          ? "ap-trunk"
          : clientPorts.has(id)
            ? "client"
            : "unused");
      const mode = override?.mode ?? (role === "ap-trunk" ? "trunk" : "access");
      const initialAccessVlan =
        override?.accessVlan ??
        (role === "management" ? managementVlan : onboardingVlan);
      this.ports.set(id, {
        id,
        name: override?.name ?? `Port ${id}`,
        enabled: override?.enabled ?? true,
        linkUp: override?.linkUp ?? false,
        speedMbps: override?.speedMbps ?? options.defaultSpeedMbps ?? 1000,
        duplex: override?.duplex ?? "full",
        mode,
        accessVlan: mode === "access" ? initialAccessVlan : undefined,
        taggedVlans:
          mode === "trunk" ? [...(override?.taggedVlans ?? [])] : undefined,
        nativeVlan:
          mode === "trunk"
            ? (override?.nativeVlan ?? managementVlan)
            : undefined,
        role,
        initialAccessVlan,
      });
    }
  }
  private before(operation: MockSwitchFailureOperation): void {
    if (!this.available)
      throw new SwitchUnavailableError(`${this.info.name} is unavailable`);
    const failure = this.failures.get(operation);
    if (failure) throw new SwitchOperationError(failure.message);
  }
  private port(portId: string): MockSwitchPort {
    const port = this.ports.get(String(portId));
    if (!port)
      throw new SwitchPortNotFoundError(`Unknown switch port: ${portId}`);
    return port;
  }
  async getInfo(): Promise<SwitchInfo> {
    this.before("getInfo");
    return { ...this.info };
  }
  async getCapabilities(): Promise<SwitchCapabilities> {
    this.before("getCapabilities");
    return { ...this.capabilities };
  }
  async getPorts(): Promise<SwitchPort[]> {
    this.before("getPorts");
    return [...this.ports.values()].map(
      ({ initialAccessVlan: _initial, ...port }) => ({
        ...port,
        taggedVlans: port.taggedVlans ? [...port.taggedVlans] : undefined,
      }),
    );
  }
  async getPort(portId: string): Promise<SwitchPort> {
    this.before("getPort");
    const { initialAccessVlan: _initial, ...port } = this.port(portId);
    return {
      ...port,
      taggedVlans: port.taggedVlans ? [...port.taggedVlans] : undefined,
    };
  }
  async setAccessVlan(portId: string, vlanId: number): Promise<void> {
    this.before("setAccessVlan");
    validVlan(vlanId);
    const port = this.port(portId);
    port.mode = "access";
    port.accessVlan = vlanId;
    port.taggedVlans = undefined;
    port.nativeVlan = undefined;
    this.forgetMacsOnPort(portId);
  }
  async setTrunkVlans(
    portId: string,
    taggedVlans: number[],
    nativeVlan?: number,
  ): Promise<void> {
    this.before("setTrunkVlans");
    const vlans = [...new Set(taggedVlans)];
    vlans.forEach(validVlan);
    if (nativeVlan !== undefined) validVlan(nativeVlan);
    const port = this.port(portId);
    port.mode = "trunk";
    port.accessVlan = undefined;
    port.taggedVlans = vlans;
    port.nativeVlan = nativeVlan;
    this.forgetMacsOnPort(portId);
  }
  async setPortEnabled(portId: string, enabled: boolean): Promise<void> {
    this.before("setPortEnabled");
    const port = this.port(portId);
    port.enabled = enabled;
    if (!enabled) {
      port.linkUp = false;
      this.forgetMacsOnPort(portId);
    }
  }
  async bouncePort(
    portId: string,
    delayMs = this.defaultBounceDelayMs,
  ): Promise<void> {
    this.before("bouncePort");
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new RangeError("delayMs must be non-negative");
    const port = this.port(portId);
    const wasEnabled = port.enabled;
    const wasLinkUp = port.linkUp;
    port.enabled = false;
    port.linkUp = false;
    this.forgetMacsOnPort(portId);
    if (delayMs > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    port.enabled = wasEnabled;
    port.linkUp = wasEnabled && wasLinkUp;
  }
  async getMacTable(): Promise<MacTableEntry[]> {
    this.before("getMacTable");
    return [...this.macs.values()].map((entry) => ({ ...entry }));
  }
  async getMacsOnPort(portId: string): Promise<MacTableEntry[]> {
    this.before("getMacsOnPort");
    this.port(portId);
    return [...this.macs.values()]
      .filter((entry) => entry.portId === String(portId))
      .map((entry) => ({ ...entry }));
  }
  async findPortByMac(mac: string): Promise<string | null> {
    this.before("findPortByMac");
    return this.macs.get(normalizeMac(mac))?.portId ?? null;
  }
  async resetPort(portId: string): Promise<void> {
    this.before("resetPort");
    const port = this.port(portId);
    port.mode = "access";
    port.accessVlan = port.initialAccessVlan;
    port.taggedVlans = undefined;
    port.nativeVlan = undefined;
    port.enabled = true;
    this.forgetMacsOnPort(portId);
  }
  async clearMacsOnPort(portId: string): Promise<void> {
    this.before("clearMacsOnPort");
    this.port(portId);
    this.forgetMacsOnPort(portId);
  }
  setAvailable(available: boolean): void {
    this.available = available;
  }
  isAvailable(): boolean {
    return this.available;
  }
  setOperationFailure(
    operation: MockSwitchFailureOperation,
    error?: Error,
  ): void {
    if (error) this.failures.set(operation, error);
    else this.failures.delete(operation);
  }
  setFailure(operation: MockSwitchFailureOperation, error?: Error): void {
    this.setOperationFailure(operation, error);
  }
  clearFailures(): void {
    this.failures.clear();
  }
  simulateLink(portId: string, linkUp: boolean): void {
    const port = this.port(portId);
    port.linkUp = linkUp && port.enabled;
  }
  setPortLink(portId: string, linkUp: boolean): void {
    this.simulateLink(portId, linkUp);
  }
  learnMac(
    mac: string,
    portId: string,
    vlanId?: number,
    dynamic = true,
    ageSeconds?: number,
  ): void {
    const port = this.port(portId);
    if (!port.enabled)
      throw new Error(`Cannot learn a MAC on disabled port ${portId}`);
    const normalizedMac = normalizeMac(mac);
    const vlan =
      vlanId ?? (port.mode === "access" ? port.accessVlan : port.nativeVlan);
    if (vlan === undefined)
      throw new Error(`No VLAN configured on port ${portId}`);
    validVlan(vlan);
    this.macs.set(normalizedMac, {
      mac: normalizedMac,
      portId: String(portId),
      vlanId: vlan,
      dynamic,
      ageSeconds,
    });
    port.linkUp = port.enabled;
  }
  simulateMacLearning(
    mac: string,
    portId: string,
    vlanId?: number,
    dynamic = true,
    ageSeconds?: number,
  ): void {
    this.learnMac(mac, portId, vlanId, dynamic, ageSeconds);
  }
  forgetMac(mac: string): void {
    this.macs.delete(normalizeMac(mac));
  }
  forgetMacsOnPort(portId: string): void {
    for (const [mac, entry] of this.macs)
      if (entry.portId === String(portId)) this.macs.delete(mac);
  }
  clearMacTable(): void {
    this.macs.clear();
  }
  setPortRole(portId: string, role: SwitchPortRole): void {
    this.port(portId).role = role;
  }
}
export class MockSwitch extends MockManagedSwitch {}
