export interface AccessPointInfo {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  managementAddress?: string;
}
export interface AccessPointCapabilities {
  maxStations: number;
  slotIds: string[];
  supportsVlanAssignment: boolean;
  supportsAssociationStatus: boolean;
  /** Optional hardware constraint used by allocators before assigning a slot. */
  supportedVlansBySlot?: Record<string, number[]>;
}
export interface TeamWirelessConfiguration {
  teamNumber: number;
  ssid: string;
  wpaKey?: string;
  vlanId: number;
}
export interface AccessPointStation {
  slotId: string;
  macAddress: string;
  teamNumber: number;
  connected: boolean;
  signalStrengthDbm?: number;
  vlanId: number;
  ssid: string;
}
export type AccessPointStationState =
  "available" | "configured" | "associated" | "offline" | "error";
export interface AccessPointStationStatus {
  slotId: string;
  state: AccessPointStationState;
  configuration?: TeamWirelessConfiguration;
  station?: AccessPointStation;
  message?: string;
}
export interface AccessPoint {
  getInfo(): Promise<AccessPointInfo>;
  getCapabilities(): Promise<AccessPointCapabilities>;
  getStations(): Promise<AccessPointStation[]>;
  configureTeam(
    slotId: string,
    configuration: TeamWirelessConfiguration,
  ): Promise<void>;
  clearTeam(slotId: string): Promise<void>;
  getStationStatus(slotId: string): Promise<AccessPointStationStatus>;
}
export class AccessPointUnavailableError extends Error {
  override name = "AccessPointUnavailableError";
}
export class AccessPointSlotNotFoundError extends Error {
  override name = "AccessPointSlotNotFoundError";
}
export class AccessPointOperationError extends Error {
  override name = "AccessPointOperationError";
}
export class UnsupportedAccessPointOperationError extends Error {
  override name = "UnsupportedAccessPointOperationError";
}
export type {
  MockAccessPointOptions,
  MockApFailureOperation,
  MockAssociation,
} from "./mock.js";
export type { VH113AccessPointOptions } from "./vh113.js";
export { MockAccessPoint, MockVH113AccessPoint } from "./mock.js";
export { VH113AccessPoint, VH113Adapter } from "./vh113.js";
