#!/bin/sh
set -eu

require_value() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "$1 is required" >&2
    exit 1
  fi
}

valid_vlan() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 4094 ]
}

ensure_vlan_interface() {
  name=$1
  vlan=$2
  address=$3

  if ip link show dev "$name" >/dev/null 2>&1; then
    if ! ip -d link show dev "$name" | grep -q "vlan.*id $vlan"; then
      echo "$name exists but is not VLAN $vlan; refusing to replace it" >&2
      exit 1
    fi
  else
    ip link add link "$FM_PARENT_INTERFACE" name "$name" type vlan id "$vlan"
  fi
  ip address replace "$address" dev "$name"
  ip link set dev "$name" up
}

for variable in FM_PARENT_INTERFACE FM_MANAGEMENT_INTERFACE FM_MANAGEMENT_VLAN FM_MANAGEMENT_ADDRESS FM_ONBOARDING_INTERFACE FM_ONBOARDING_VLAN FM_ONBOARDING_ADDRESS; do
  require_value "$variable"
done

if ! ip link show dev "$FM_PARENT_INTERFACE" >/dev/null 2>&1; then
  echo "Parent interface $FM_PARENT_INTERFACE does not exist" >&2
  exit 1
fi
if ! valid_vlan "$FM_MANAGEMENT_VLAN" || ! valid_vlan "$FM_ONBOARDING_VLAN"; then
  echo "VLAN IDs must be integers from 1 through 4094" >&2
  exit 1
fi
if [ "$FM_MANAGEMENT_VLAN" = "$FM_ONBOARDING_VLAN" ]; then
  echo "Management and onboarding VLAN IDs must differ" >&2
  exit 1
fi

ensure_vlan_interface "$FM_MANAGEMENT_INTERFACE" "$FM_MANAGEMENT_VLAN" "$FM_MANAGEMENT_ADDRESS"
if [ -n "${FM_AP_MANAGEMENT_ADDRESS:-}" ]; then
  ip address replace "$FM_AP_MANAGEMENT_ADDRESS" dev "$FM_MANAGEMENT_INTERFACE"
fi
ensure_vlan_interface "$FM_ONBOARDING_INTERFACE" "$FM_ONBOARDING_VLAN" "$FM_ONBOARDING_ADDRESS"

ip -brief address show dev "$FM_MANAGEMENT_INTERFACE"
ip -brief address show dev "$FM_ONBOARDING_INTERFACE"

# Remain alive so Docker reruns this idempotent setup whenever it restarts the
# container, including after a host reboot where VLAN interfaces no longer
# exist. The health check gates dependent services during `docker compose up`.
trap 'exit 0' INT TERM
while :; do
  sleep 3600 &
  wait "$!"
done
