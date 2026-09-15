export type SwitchPortMode = "access" | "trunk";
export type SwitchPortRole =
  "client" | "ap-trunk" | "server" | "management" | "unused";

export interface SwitchInfo {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  managementAddress?: string;
}
export interface SwitchCapabilities {
  maxPorts: number;
  supportsAccessVlans: boolean;
  supportsTrunks: boolean;
  supportsPortBounce: boolean;
  supportsMacTable: boolean;
  supportsPortEnable: boolean;
}
export interface SwitchPort {
  id: string;
  name: string;
  enabled: boolean;
  linkUp: boolean;
  speedMbps?: number;
  duplex?: "half" | "full";
  mode: SwitchPortMode;
  accessVlan?: number;
  taggedVlans?: number[];
  nativeVlan?: number;
  role: SwitchPortRole;
}
export interface MacTableEntry {
  mac: string;
  portId: string;
  vlanId: number;
  dynamic: boolean;
  ageSeconds?: number;
}

/** Optional installation defaults used when constructing an adapter. */
export interface SwitchConfig {
  managementVlan: number;
  onboardingVlan: number;
  clientPorts?: string[];
  apTrunkPorts?: string[];
}

export interface ManagedSwitch {
  getInfo(): Promise<SwitchInfo>;
  getCapabilities(): Promise<SwitchCapabilities>;
  getPorts(): Promise<SwitchPort[]>;
  getPort(portId: string): Promise<SwitchPort>;
  setAccessVlan(portId: string, vlanId: number): Promise<void>;
  setTrunkVlans(
    portId: string,
    taggedVlans: number[],
    nativeVlan?: number,
  ): Promise<void>;
  setPortEnabled(portId: string, enabled: boolean): Promise<void>;
  bouncePort(portId: string, delayMs?: number): Promise<void>;
  getMacTable(): Promise<MacTableEntry[]>;
  getMacsOnPort(portId: string): Promise<MacTableEntry[]>;
  findPortByMac(mac: string): Promise<string | null>;
  resetPort(portId: string): Promise<void>;
  /** Optional vendor-supported forwarding-table flush for a single port. */
  clearMacsOnPort?(portId: string): Promise<void>;
}

export class SwitchUnavailableError extends Error {
  override name = "SwitchUnavailableError";
}
export class SwitchPortNotFoundError extends Error {
  override name = "SwitchPortNotFoundError";
}
export class SwitchOperationError extends Error {
  override name = "SwitchOperationError";
}
export class UnsupportedSwitchOperationError extends Error {
  override name = "UnsupportedSwitchOperationError";
}

export type {
  MockManagedSwitchOptions,
  MockSwitchFailureOperation,
} from "./mock.js";
export type {
  Extreme5420SwitchOptions,
  SwitchEngineCliTransport,
  SwitchEngineJsonRpcOptions,
} from "./extreme5420.js";
export type {
  Extreme5420FabricEngineSwitchOptions,
  FabricEngineCliTransport,
  FabricEngineSshOptions,
} from "./extreme5420-voss.js";
export { MockManagedSwitch, MockSwitch } from "./mock.js";
export { CiscoSwitch } from "./cisco.js";
export {
  Extreme5420M48W4YESwitch,
  Extreme5420Switch,
  SwitchEngineJsonRpcTransport,
} from "./extreme5420.js";
export {
  Extreme5420FabricEngineSwitch,
  Extreme5420VossSwitch,
  FabricEngineSshTransport,
} from "./extreme5420-voss.js";
