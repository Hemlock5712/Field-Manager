import {
  UnsupportedAccessPointOperationError,
  type AccessPoint,
  type AccessPointCapabilities,
  type AccessPointInfo,
  type AccessPointStation,
  type AccessPointStationStatus,
  type TeamWirelessConfiguration,
} from "./index.js";
// Firmware identifiers stay private to this adapter; core deals only in opaque slot IDs.
const VH113_SLOT_IDS = ["red1", "red2", "red3", "blue1", "blue2", "blue3"];
/** Real VH-113 boundary. Transport/request shapes remain TODO until target firmware is verified. */
export class VH113AccessPoint implements AccessPoint {
  constructor(readonly info: AccessPointInfo) {}
  getInfo(): Promise<AccessPointInfo> {
    return Promise.resolve({ ...this.info });
  }
  getCapabilities(): Promise<AccessPointCapabilities> {
    return Promise.resolve({
      maxStations: VH113_SLOT_IDS.length,
      slotIds: [...VH113_SLOT_IDS],
      supportsVlanAssignment: true,
      supportsAssociationStatus: true,
    });
  }
  getStations(): Promise<AccessPointStation[]> {
    return Promise.reject(this.unsupported("getStations"));
  }
  configureTeam(
    _slotId: string,
    _configuration: TeamWirelessConfiguration,
  ): Promise<void> {
    return Promise.reject(this.unsupported("configureTeam"));
  }
  clearTeam(_slotId: string): Promise<void> {
    return Promise.reject(this.unsupported("clearTeam"));
  }
  getStationStatus(_slotId: string): Promise<AccessPointStationStatus> {
    return Promise.reject(this.unsupported("getStationStatus"));
  }
  private unsupported(operation: string): UnsupportedAccessPointOperationError {
    return new UnsupportedAccessPointOperationError(
      `VH-113 operation '${operation}' is pending firmware/API verification`,
    );
  }
}

export class VH113Adapter extends VH113AccessPoint {}
