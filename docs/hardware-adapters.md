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

### Extreme 5420M-48W-4YE

`Extreme5420Switch` supports a 5420M-48W-4YE running **Switch Engine/ExtremeXOS**. It uses the vendor's HTTPS/HTTP Basic authenticated JSON-RPC `cli` method at `/jsonrpc/`. The web interface/JSON-RPC service must be enabled and HTTPS should use a certificate trusted by the Field Manager host.

The adapter implements port detail and VID readback, access and tagged/native VLAN replacement, port enable/disable and bounce, FDB lookup/flush, model verification, and optional `save configuration primary`. Writes are serialized and verified by readback. Configuration persistence is off by default because saving every short-lived practice-field assignment increases flash writes; enable it only when assignments must survive a switch restart.

The default port inventory is the 48 copper plus four uplink data ports (`1` through `52`). Stacked systems must supply their actual port IDs (for example `1:1`) and application roles. The adapter creates missing VLANs as `FM-<VID>` but never deletes VLANs. Test the exact installed Switch Engine release in a lab before field use.

`Extreme5420FabricEngineSwitch` supports the same chassis running **Fabric
Engine/VOSS**. It uses a password-authenticated interactive SSH session, pins
the switch's OpenSSH SHA256 host-key fingerprint, and disables CLI paging for
each session. Its defaults are ports `1/1` through `1/52` and VLAN IDs 1-4059.
It maps access/native/tagged VLAN behavior to Fabric Engine's VLAN membership,
802.1Q encapsulation, default VLAN, and frame-discard controls.

The Fabric Engine adapter reads physical state, membership, and the VLAN FDB;
serializes and verifies writes; clears learned MACs individually on a port;
and optionally runs `save config`. Set `FM_SWITCH_OS=fabric-engine`, use an
`ssh://` management URL, and configure `FM_SWITCH_SSH_HOST_KEY_SHA256`.
`FM_SWITCH_OS=voss` is accepted as an alias. As with the Switch Engine adapter,
the application owns only explicitly listed ports and never deletes VLANs.
VOSS 8.4.0 can be reached only when
`FM_SWITCH_ALLOW_LEGACY_SSH_KEX=true`; this appends group14-sha1 for that switch
without enabling the weaker group1 method. Keep the option false on releases
that offer a SHA-2 key exchange.

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

### VH-113

`VH113AccessPoint` implements the open `frc-radio-api` protocol used by the VH-113 field access point: bearer-token authentication, `GET /status`, and asynchronous whole-document `POST /configuration` with polling/readback. It normalizes the six firmware slot IDs, associations, MACs, signal strength, firmware version, SSID, and VLAN state.

Firmware constraints are enforced before a write: SSIDs are 1-14 alphanumeric/hyphen characters, WPA keys are 8-16 alphanumeric characters, and each slot can use only its position in VLAN banks `10_20_30`, `40_50_60`, or `70_80_90`. Red and blue must use different banks. These slot constraints are exposed to the VLAN allocator.

The AP API rewrites all six slots on every configuration request and never returns plaintext WPA keys. The adapter therefore refuses a write if another configured slot's plaintext desired state is unknown. On process startup, callers must populate `initialConfigurations` from their credential store before changing a partially configured AP. This prevents a one-slot update from silently disabling other teams.

Before event use, confirm that the installed AP firmware exposes the documented API (normally port 8081), validate channel/regulatory settings, verify that AP VLAN banks match the switch trunk, and exercise reboot and rollback behavior in a lab.

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
