# Hardware adapters

Hardware is behind small, capability-oriented interfaces. The domain and HTTP layers must never issue vendor CLI commands, depend on a vendor's station names, or assume a particular switch model.

## Managed switch contract

The contract should support the required MVP operations and explicit readback:

```ts
interface ManagedSwitch {
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
}
```

`SwitchPort` includes ID/name, enabled/link state, optional speed/duplex, mode (`access`/`trunk`), access VLAN or tagged/native VLANs, and an application role (`client`, `ap-trunk`, `management`, `server`, `unused`). `MacTableEntry` includes normalized MAC, port, VLAN, dynamic/static flag, and optional age. Adapters should normalize vendor-specific representations and throw typed, actionable errors for unavailable devices, unsupported operations, authorization failures, and write/readback mismatches.

### Mock switch

The mock adapter is the reference behavior for local development. It should support a configurable port count, initial roles/VLANs, simulated link and availability state, learned MAC entries, access/trunk writes, enable/disable, bounce delay, reset, and MAC-table queries. Disabling a mock port forces link down and flushes its learned MAC entries; enabling leaves link down until a simulated device is learned again. Returning a client port to onboarding is an application operation that detaches the assignment, writes the onboarding VLAN, enables the port, and flushes learned MACs. A simulation control can learn/forget a fake device or toggle link state without changing production abstractions. The mock must model a bounce as a brief disable/enable transition and preserve enough state for tests to assert it.

### Vendor adapters

Each vendor gets its own package/module. It translates the contract to the vendor's supported API/CLI, handles authentication and rate limits, and records model/firmware/capability differences. Do not implement a generic switch-management surface for routing, QoS, LACP, ACLs, STP, or PoE just because a vendor supports them. A first real adapter should be developed only after capturing sanitized command/API examples from the exact switch firmware and testing in a lab.

## Access-point contract

```ts
interface AccessPoint {
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
```

Capabilities expose available slot IDs, maximum simultaneous stations (if any), supported VLAN/security options, and firmware information. Core code consumes opaque slot IDs. A mock VH-113 may expose six slots and simulate team/SSID/key/VLAN configuration, association/disassociation, signal strength, and station status. The six slots are a mock of current hardware behavior, not a system limit.

### VH-113 status

The repository should contain a real VH-113 adapter skeleton with configuration and TODO markers, but must not invent endpoint paths, payloads, authentication, or station-state semantics. The exact API remains to be verified against the target firmware and available vendor documentation/source. Before enabling it at an event, verify:

- management transport, authentication, TLS/certificate behavior, and timeout/retry limits;
- slot discovery and whether identifiers are stable across firmware versions;
- exact team/SSID/WPA/VLAN configuration operations and their commit semantics;
- station association status, signal units, stale-state behavior, and reboot impact;
- whether VLAN tags/native VLANs on the AP trunk match the switch configuration;
- safe rollback/clear behavior and audit logging.

Until these are verified, use the mock adapter or a lab-only implementation behind a feature flag.

## DHCP and credential interfaces

The portal needs a lease lookup, not a new DHCP server:

```ts
interface DhcpLeaseProvider {
  getLeaseByIp(ip: string): Promise<DhcpLease | null>;
  getLeaseByMac(mac: string): Promise<DhcpLease | null>;
}

interface CredentialStore {
  put(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}
```

The mock provider uses deterministic leases. A production provider can query an existing DHCP server, lease database, or authenticated API. WPA keys and switch/AP passwords should be kept out of logs and ordinary API responses. Environment variables are acceptable for local development; SQLite plaintext is acceptable only as a clearly marked, permission-restricted development fallback. Production should use OS keychain/secrets manager or envelope encryption and support rotation.

## Adapter lifecycle and failure handling

Adapters should make availability and errors explicit. Application services may retry safe reads with bounded backoff, but disruptive writes and bounces should be idempotent and never retried blindly. A successful write followed by a failed readback is `unknown`/drift until reconciliation confirms state. Log resource IDs, operation IDs, and sanitized error codes; never log credentials.
