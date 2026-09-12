import {
  UnsupportedSwitchOperationError,
  type ManagedSwitch,
  type SwitchCapabilities,
  type SwitchInfo,
  type SwitchPort,
  type MacTableEntry,
} from "./index.js";

/** Real adapter boundary. Transport/commands remain TODO until the exact model and firmware are verified. */
export class CiscoSwitch implements ManagedSwitch {
  constructor(readonly info: SwitchInfo) {}
  private unsupported(operation: string): UnsupportedSwitchOperationError {
    return new UnsupportedSwitchOperationError(
      `Cisco adapter operation '${operation}' requires verified model/firmware integration`,
    );
  }
  getInfo(): Promise<SwitchInfo> {
    return Promise.resolve({ ...this.info });
  }
  getCapabilities(): Promise<SwitchCapabilities> {
    return Promise.reject(this.unsupported("getCapabilities"));
  }
  getPorts(): Promise<SwitchPort[]> {
    return Promise.reject(this.unsupported("getPorts"));
  }
  getPort(_portId: string): Promise<SwitchPort> {
    return Promise.reject(this.unsupported("getPort"));
  }
  setAccessVlan(_portId: string, _vlanId: number): Promise<void> {
    return Promise.reject(this.unsupported("setAccessVlan"));
  }
  setTrunkVlans(
    _portId: string,
    _taggedVlans: number[],
    _nativeVlan?: number,
  ): Promise<void> {
    return Promise.reject(this.unsupported("setTrunkVlans"));
  }
  setPortEnabled(_portId: string, _enabled: boolean): Promise<void> {
    return Promise.reject(this.unsupported("setPortEnabled"));
  }
  bouncePort(_portId: string, _delayMs?: number): Promise<void> {
    return Promise.reject(this.unsupported("bouncePort"));
  }
  getMacTable(): Promise<MacTableEntry[]> {
    return Promise.reject(this.unsupported("getMacTable"));
  }
  getMacsOnPort(_portId: string): Promise<MacTableEntry[]> {
    return Promise.reject(this.unsupported("getMacsOnPort"));
  }
  findPortByMac(_mac: string): Promise<string | null> {
    return Promise.reject(this.unsupported("findPortByMac"));
  }
  resetPort(_portId: string): Promise<void> {
    return Promise.reject(this.unsupported("resetPort"));
  }
}
