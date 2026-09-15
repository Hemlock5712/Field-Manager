# Development guide

## Prerequisites

Use Bun 1.4 or Node 22+ locally. pnpm drives the requested install/task workflow, the Fastify development process uses Node through `tsx` for SQLite driver compatibility, and the repository remains Bun-workspace compatible.

```sh
pnpm install
pnpm dev
```

Equivalent Bun commands are:

```sh
bun install
bun run dev
```

The development profile must use mock switch, AP, DHCP, and credential adapters. It should use a local SQLite file and must not require root networking permissions or access to an event network.

## Useful checks

Run the repository-wide checks before handing off a change:

```sh
pnpm test
pnpm check-types
pnpm lint
pnpm build
```

Use the equivalent `bun run ...` scripts if pnpm is unavailable. Keep unit tests deterministic and isolate SQLite databases per test. Tests should cover allocator persistence/collision behavior, port transitions, portal correlation, hardware failures, and reconciliation drift.

## Simulation workflow

Start the server and web app, then use the dashboard's development controls (or the development-only simulator API) to:

1. inspect the seeded 24-port switch and team networks;
2. connect a fake laptop to an onboarding port and learn its MAC;
3. open the portal, submit a team number, and observe VLAN assignment plus bounce;
4. toggle link state and robot association to observe `link down`, `waiting-for-robot`, and `online`;
5. make the switch/AP unavailable or force a write failure;
6. run reconciliation and inspect the reported desired/actual drift;
7. re-learn the simulated device and restore its DHCP lease before the next portal test.

Simulation endpoints and controls must be development-only, clearly labeled, and disabled in production. Seed data is illustrative: team numbers and VLANs may change as fixtures evolve.

The MVP simulator API is available under `/api/dev`:

```text
GET  /api/dev/state
POST /api/dev/switches/:id/availability
POST /api/dev/switches/:id/ports/:portId
POST /api/dev/access-points/:id/availability
POST /api/dev/access-points/:id/stations/:slotId
POST /api/dev/dhcp/leases
DELETE /api/dev/dhcp/leases/:ip
POST /api/dev/failures
POST /api/dev/reset
```

`GET /api/dev/state` reports the complete mock teams, switches, AP stations, forwarding tables, leases, configuration, and compatibility availability flags. The switch-port POST accepts `enabled`, `linkUp`, `mac`, `vlanId`, and `clearMacs`; `clearMacs` flushes learned MACs on that port, while supplying `mac` learns one (and can set its VLAN). A MAC can only be learned while the port is enabled, and learning makes the simulated link up. Disabling a port forces link down and flushes its learned MACs; enabling it does not create a device or forwarding entry. The AP-station POST accepts optional `associated`, `mac`, and `signalStrengthDbm`; setting `associated: false` disassociates, while an association requires a configured slot. Availability endpoints make subsequent adapter operations fail as unavailable. These routes are for the mock profile only and must be gated or omitted when a production profile is added.

The DHCP fixture is independently editable. `POST /api/dev/dhcp/leases` creates or replaces the lease for the supplied IP and returns `201`; its JSON body requires an IPv4/IPv6 `ip` and colon-separated MAC, with optional `vlanId`, `hostname`, and ISO `expiresAt`. `DELETE /api/dev/dhcp/leases/:ip` removes that lease and returns `204`; URL-encode the IP when needed. The portal still requires both halves of the correlation: a non-stale IP→MAC lease and a learned MAC→port entry. Clearing/resetting the switch does not recreate either one, so re-learn the physical MAC and create/update a matching lease before retrying the portal.

`POST /api/dev/failures` injects a mock failure with `{ "hardware": "switch" | "access-point", "operation": "...", "message": "...", "id": "..." }`. The optional `id` selects a non-default device; a non-null message enables the named failure and `message: null` clears it. Supported operation names are adapter-specific mock operations such as `getPorts`, `setAccessVlan`, `bouncePort`, `findPortByMac`, `configureTeam`, and `getStationStatus`; unsupported names return validation errors. The endpoint returns the selected hardware/operation and whether a failure was enabled.

### Port-control semantics

The administrative port PATCH is `/api/switches/:id/ports/:portId`:

```text
{ "enabled": false }       disable and flush the simulated port
{ "enabled": true }        enable; link remains down until a device is learned
{ "teamNetworkId": null }  return to onboarding
```

The mock contract for disabling is deliberately stronger than changing a flag: it forces `enabled=false`, forces `linkUp=false`, and flushes every learned MAC on that port. Disabling does not detach the persisted team assignment; use Return to onboarding when the port should stop belonging to that team. Re-enabling does not invent a physical device or restore a forwarding-table entry. A real switch adapter must provide equivalent readback or report that the behavior is unsupported.

Returning a client port to onboarding detaches its persisted `teamNetworkId`, writes the configured onboarding VLAN, enables the port, flushes learned MACs, and (when invoked through the administrative API) performs the configured port bounce. The port is then ready for a new laptop, but the simulated laptop must be learned again with the dev control, for example:

```json
{
  "linkUp": true,
  "mac": "AA:BB:CC:DD:EE:FF",
  "vlanId": 999
}
```

The DHCP lease is a separate fixture. Its IP-to-MAC mapping must still match the re-learned MAC and must not be stale. Use the lease endpoints above to create/update or delete it. A port bounce or reset may also clear hardware learning, so always verify `GET /api/switches/:id/ports/:portId` and re-learn the simulated device before retrying `/api/portal/connect`.

### Reset safety

The switch adapter's `resetPort(portId)` is a hardware reconciliation primitive, not a demo-data reset. A safe implementation is scoped to one known port, restores that adapter's documented baseline, enables the port when appropriate, and flushes learned MACs; it must not delete SQLite team networks or rewrite every port. Run reconciliation first, confirm the desired/actual drift, and use reset only on an explicitly selected resource. Some real adapters may not support reset and should report that capability honestly.

The simulator reset endpoint is `POST /api/dev/reset`. It accepts either canonical payload:

```json
{ "mode": "hardware-to-desired" }
```

or the compatibility alias:

```json
{ "scope": "hardware" }
```

An empty object (or no body) defaults to `hardware-to-desired`.

Use `hardware-to-desired`/`hardware` for safe recovery. It clears simulated switch/AP outages and injected failures, reapplies the persisted desired switch VLAN/mode and AP configuration, enables switch ports, clears AP associations, and flushes learned MAC entries (the simulated endpoint/link presence is not recreated). It preserves SQLite team networks and DHCP leases. A port that was disabled remains without a learned device/link until the simulator drives it again; verify the returned state and re-learn the MAC/link simulation before portal testing. The endpoint returns the complete post-reset simulator state.

Use `{ "mode": "seeded-demo" }` or `{ "scope": "demo" }` only for a complete fixture reset. The canonical `mode` wins if both `mode` and `scope` are supplied. This operation clears team credentials and records, AP slot configuration/associations, switch/AP failures, simulated forwarding entries, and DHCP leases, then rebuilds the seeded 24-port demo (including the sample teams and lease). It replaces all local simulator state, so the UI must require explicit confirmation. It is development-only and must never be used as the repair path for real hardware or enabled in a production profile.

## Configuration

Keep installation-specific values in validated configuration, not scattered constants. At minimum configure:

```text
management VLAN
onboarding VLAN
team VLAN pool/range
default port-bounce delay
switch/AP adapter selection and connection metadata
DHCP lease-provider settings
credential-store selection
```

The sample mock switch configuration demonstrates management VLAN 100, onboarding VLAN 999, client ports, and an AP trunk. Do not copy those values blindly to a real field. Secrets belong in environment variables or the configured credential store; do not commit them to `config/`.

## Contributing boundaries

When adding functionality, keep this dependency direction:

```text
web -> API routes -> application services -> domain contracts
                                      -> repositories
                                      -> hardware adapters
```

Routes validate and map; services orchestrate; adapters translate hardware protocols; repositories persist desired state. Add a shared Zod schema when a request/response crosses the web/API boundary. Prefer typed domain errors and explicit operation results to string matching.

## Real hardware readiness checklist

Before a field deployment:

- test the exact switch model/firmware in a lab and capture access/trunk/bounce/MAC-table readback;
- verify management reachability and credentials without logging secrets;
- confirm onboarding/team DHCP scopes, DNS, CAPPORT/connectivity-check behavior, and routing isolation;
- verify AP trunk/native VLAN semantics and team VLAN propagation;
- verify the installed VH-113 firmware matches the documented `frc-radio-api`, including configuration commit, station status, and clear/rollback behavior;
- exercise unavailable hardware, timeout, partial-write, stale-lease, duplicate-MAC, and ambiguous-port cases;
- back up switch/AP configuration and have a manual rollback procedure;
- enable reconciliation and review drift before allowing broad operator access.

The real adapters are implemented but must remain opt-in until the exact hardware and firmware have passed the lab checklist. The 5420 has separate Switch Engine/EXOS and Fabric Engine/VOSS adapters selected by `FM_SWITCH_OS`. The mock path remains the supported way to develop and demonstrate the system.

## Troubleshooting

If a portal connection cannot find a port, inspect the DHCP lease age/IP-to-MAC mapping and the switch's learned MAC table. If the VLAN appears wrong, compare readback with the desired assignment and run reconciliation; do not assume the database proves hardware state. If the robot is offline while the client port is correct, inspect AP station status, trunk VLANs, and DHCP on the team VLAN. If a test is flaky, reset the mock state and use an isolated SQLite database rather than sharing the development database.
