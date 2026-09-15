/** The lifecycle of a temporary, isolated robot network. */
export type TeamNetworkStatus =
  "provisioning" | "waiting-for-robot" | "online" | "offline" | "error";

/** A network allocated to one FRC team. It is intentionally independent of field/alliance concepts. */
export interface TeamNetwork {
  id: string;
  teamNumber: number;
  vlanId: number;
  accessPointId?: string;
  accessPointSlot?: string;
  wirelessSsid?: string;
  credentialReference?: string;
  status: TeamNetworkStatus;
  statusMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationPortRole =
  "client" | "ap-trunk" | "server" | "management" | "unused";

/** Desired application ownership for a physical switch port. */
export interface PortAssignment {
  switchId: string;
  portId: string;
  teamNetworkId?: string;
  role: ApplicationPortRole;
  label?: string;
  updatedAt: string;
}

export interface NetworkConfiguration {
  managementVlan: number;
  onboardingVlan: number;
  teamVlanStart: number;
  teamVlanEnd: number;
  portBounceDelayMs: number;
}

/** Persisted installation settings. Kept as an alias for API and storage adapters. */
export type InstallationConfig = NetworkConfiguration;

export type PortRole = ApplicationPortRole;

export interface SwitchRecord {
  id: string;
  displayName: string;
  adapterType: string;
  managementAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface AccessPointRecord {
  id: string;
  displayName: string;
  adapterType: string;
  managementAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface DhcpLease {
  ip: string;
  mac: string;
  vlanId?: number;
  hostname?: string;
  expiresAt?: string;
}

/** Read-only lease lookup needed to correlate a portal request with a physical switch port. */
export interface DhcpLeaseProvider {
  getLeaseByIp(ip: string): Promise<DhcpLease | null>;
  getLeaseByMac(mac: string): Promise<DhcpLease | null>;
}

/** A reference to a secret, allowing local SQLite storage to be replaced by a vault later. */
export interface CredentialStore {
  put(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

export interface NetworkHealthIssue {
  kind:
    | "switch-port-drift"
    | "access-point-drift"
    | "hardware-unavailable"
    | "error";
  message: string;
  switchId?: string;
  portId?: string;
  teamNetworkId?: string;
  accessPointId?: string;
  slotId?: string;
}

export type DriftItem = NetworkHealthIssue;

export interface NetworkHealthReport {
  healthy: boolean;
  checkedAt: string;
  issues: NetworkHealthIssue[];
}
