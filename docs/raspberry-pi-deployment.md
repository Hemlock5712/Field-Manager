# Raspberry Pi Docker deployment

This profile runs Field Manager, its web UI, and onboarding DHCP/DNS on a
64-bit Raspberry Pi. It assumes the VH-113 is running the **Practice** firmware
profile and provides DHCP on the team VLANs. dnsmasq serves VLAN 999 only.

## Topology

Connect the Pi's Ethernet port to a switch port tagged for management VLAN 100
and onboarding VLAN 999. The boot-persistent `network-init` container creates
these host interfaces:

| Interface    | Address      | Purpose                                      |
| ------------ | ------------ | -------------------------------------------- |
| `fm-mgmt`    | `10.0.100.5` | Switch/API management and operator access    |
| `fm-mgmt`    | `10.57.12.2` | Secondary address for the AP at `10.57.12.1` |
| `fm-onboard` | `10.99.0.1`  | Onboarding DHCP, DNS, and portal             |

The containers use host networking because DHCP discovery is a Layer-2
broadcast and because the services must bind directly to `fm-onboard`.
dnsmasq is explicitly configured for that interface and cannot answer on the
team VLANs.

## Prepare the Pi

Install a current 64-bit Raspberry Pi OS and Docker Engine with the Compose
plugin. Give the Pi a stable hostname, apply OS updates, enable time sync, and
restrict SSH to the management network. To run Docker without prefixing every
command with `sudo`, add the deployment user to Docker's local group:

```sh
sudo systemctl enable --now docker
sudo groupadd --force docker
sudo usermod --append --groups docker "$USER"
```

Membership in the `docker` group grants root-equivalent access. Log out of the
Pi completely and log back in, then confirm `docker info` succeeds. Opening a
new terminal inside the same login session is not sufficient. As a temporary
alternative, prefix the documented `docker compose` commands with `sudo`.

Clone this repository, then:

```sh
cd deploy/raspberry-pi
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
printf '%s\n' 'replace-with-switch-password' > secrets/switch-password.txt
: > secrets/ap-token.txt
chmod 600 secrets/*.txt
```

If the AP API requires a bearer token, put it in `secrets/ap-token.txt`.
Otherwise leave that file empty. These files and `.env` are ignored by Git.

Edit `.env` before starting anything:

- set `FM_PARENT_INTERFACE` to the physical Pi NIC attached to the trunk;
- set `FM_SWITCH_OS` to `switch-engine` or `fabric-engine` and configure its
  reviewed management URL and username;
- for Fabric Engine, set an `ssh://` URL and the independently verified
  `FM_SWITCH_SSH_HOST_KEY_SHA256` value;
- set `FM_SWITCH_ALLOW_LEGACY_SSH_KEX=true` only when an isolated VOSS 8.4.0
  switch cannot be upgraded yet; return it to `false` after upgrading;
- enumerate every application-owned port explicitly;
- make the client, AP trunk, server, management, and unused lists disjoint;
- confirm that the AP API is actually reachable at
  `http://10.57.12.1:8081`;
- select an approved 5 GHz channel and width.

Compose reads `.env` automatically, but the host shell does not. After editing
the file, export its values into the current shell before running the host-side
verification commands below:

```sh
set -a
. ./.env
set +a
```

Run this from `deploy/raspberry-pi`. Repeat it after opening a new shell or
changing `.env`. Only source an `.env` file that you trust.

The default `FM_SWITCH_PORT_IDS` is `1`-`52` for Switch Engine and
`1/1`-`1/52` for Fabric Engine. Specify it for a stack, channelized port, or any
switch whose CLI reports another identifier format. Never copy the example
port ownership into a live switch without comparing it to the cabling plan.

The nginx policy assumes management clients are in `10.0.100.0/24`. If that
subnet changes, update the `allow` entry in
`deploy/raspberry-pi/nginx.conf`. If the onboarding subnet changes, update the
Pi address, dnsmasq pool/options, AP portal URL, and nginx policy together.

## Switch-side prerequisites

The Pi-facing switch port is an 802.1Q trunk with VLANs 100 and 999 tagged. The
VH-113-facing port has management as its native VLAN and active team VLANs
tagged. The application must not own the Pi-facing infrastructure port as a
client port. On VOSS, disable Auto-sense on every application-owned port before
configuring it; an Auto-sense port in private VLAN 4048 is not connected to
Field Manager's onboarding VLAN 999.

Before launch, verify from the Pi host. For Switch Engine:

```sh
ip link show "$FM_PARENT_INTERFACE"
curl --fail --user "$FM_SWITCH_USER:$(cat secrets/switch-password.txt)" \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"cli","params":["show switch"],"id":1}' \
  "$FM_SWITCH_URL/jsonrpc/"
```

For Fabric Engine/VOSS:

```sh
ssh -oKexAlgorithms=+diffie-hellman-group14-sha1 \
  -oHostKeyAlgorithms=+ssh-rsa \
  "$FM_SWITCH_USER@10.0.100.2" 'show sys-info'
ssh -oKexAlgorithms=+diffie-hellman-group14-sha1 \
  -oHostKeyAlgorithms=+ssh-rsa \
  "$FM_SWITCH_USER@10.0.100.2" 'show interfaces gigabitEthernet vlan'
```

Those manual OpenSSH commands require the same one-connection legacy options
when the switch still runs VOSS 8.4.0. The Field Manager service obtains its
compatibility setting from `FM_SWITCH_ALLOW_LEGACY_SSH_KEX` instead.

Compare the SSH host-key fingerprint against the value obtained over the
trusted console path before placing it in `.env`.

Do not put the password on a shared shell or retain it in shell history; the
command is intended only for an isolated commissioning session.

## Validate and start

Compose interpolation checks catch missing required variables before launch:

```sh
docker compose config --quiet
docker compose build
```

### Use published GHCR images

The release workflow publishes four ARM64 images to GitHub Container Registry:
`server`, `web`, `network-init`, and `dnsmasq`. It does not receive the Pi's
`.env`, switch password, or AP token. To use these images, set `FM_IMAGE_TAG` in
`.env` to a published immutable release such as `1.2.3`, or to the full
`sha-...` tag shown by the workflow. Do not use an unpinned `latest` tag.

While the Pi still has internet access, pull the complete release:

```sh
docker compose --env-file .env \
  --file compose.yaml \
  --file compose.ghcr.yaml \
  pull
```

If the GHCR packages are private, log in first using a token that has only the
package-read permission. Once the images are present, move the Pi to the field
network and create or update the containers without building:

```sh
docker compose --env-file .env \
  --file compose.yaml \
  --file compose.ghcr.yaml \
  up --detach --no-build --force-recreate
```

Use both Compose files for future pull or update operations. Docker's stored
restart policies do not require registry access during an ordinary reboot.

If the build network overlaps the field management subnet, finish the build
before moving the Pi. Do not leave the overlapping home Ethernet or Wi-Fi
connection active when starting Field Manager. After the build completes:

1. Use a local console or a separate connection whose subnet does not overlap.
2. Disconnect the Pi from the home network.
3. Connect `FM_PARENT_INTERFACE` to the tagged switch trunk.
4. Ensure the physical parent interface is up but does not retain a home-network
   IPv4 address. Configure its OS network profile as a trunk with IPv4 and IPv6
   disabled; the `network-init` service assigns addresses to the VLAN children.
5. Start the deployment:

```sh
docker compose up -d
docker compose ps
docker compose logs --tail=100 network-init dnsmasq server web
```

Docker starts these containers from their restart policies when the daemon
starts; no interactive login is required. `network-init` remains running so its
idempotent setup executes again after every host reboot. Compose health-gates
the initial launch; after a daemon restart, dnsmasq's dynamic binding tolerates
the brief interface recreation window. Verify the boot configuration with:

```sh
sudo systemctl is-enabled docker
docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' field-manager-network-init-1
```

Both commands should report `enabled` and `unless-stopped`, respectively. The
exact container name can vary if the Compose project name is overridden; use
`docker compose ps -q network-init` with `docker inspect` in that case.

Confirm that Linux selects the tagged management interface for the switch:

```sh
ip route get 10.0.100.2
```

The result must contain `dev fm-mgmt` and `src 10.0.100.5`. If it selects the
home interface, stop and remove the overlapping connection before continuing.

The first build produces ARM64 images directly on a 64-bit Pi. Persistent
volumes retain SQLite state and dnsmasq leases across container replacement.
The server reads the lease volume but cannot write it.

Expected endpoints are:

- operator UI: `http://10.0.100.5/`;
- captive portal: `http://10.99.0.1/portal`;
- health from the Pi: `http://127.0.0.1:3000/api/health`.

The API server listens only on loopback. nginx allows `/api/portal/session` and
`/api/portal/connect` from onboarding; other `/api` routes are allowed only
from localhost and `10.0.100.0/24`. `/api/dev` is not registered in production.

## Verify DHCP boundaries

Connect a test laptop to an onboarding client port and verify:

```sh
docker compose exec dnsmasq cat /var/lib/misc/dnsmasq.leases
docker compose logs --tail=100 dnsmasq
curl http://10.99.0.1/portal
```

The laptop should receive `10.99.0.50-250`, DNS `10.99.0.1`, and portal option 114. It must not reach switch/AP management or administrative API endpoints.

Create one team in the operator UI, connect through the portal, and confirm the
port moves from VLAN 999 to the slot-supported team VLAN. After the bounce, the
client's onboarding lease stops applying and the Practice AP firmware should
supply the team-VLAN lease. Verify that dnsmasq does **not** log a request from
the team VLAN.

## Operations and recovery

Use these read-only checks first:

```sh
docker compose ps
docker compose logs --tail=200 server dnsmasq
ip -brief address show fm-mgmt
ip -brief address show fm-onboard
```

`docker compose down` removes containers but intentionally leaves the host VLAN
interfaces in place and preserves named volumes. Re-running `docker compose up
-d` is idempotent. Remove or alter the host VLAN interfaces manually only in a
planned maintenance window after confirming they are not carrying management
traffic.

If the AP web page labels the unit VH-109 while the chassis is physically a
VH-113, treat the label as firmware metadata, not proof of hardware
compatibility. This deployment assumes the API health/status calls and one
isolated end-to-end slot test have passed. Do not flash another image solely to
change that displayed model string.
