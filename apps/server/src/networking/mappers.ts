import type { TeamNetwork } from "@repo/core";
import type { TeamNetworkRecord } from "@repo/db";

export function toTeamNetwork(record: TeamNetworkRecord): TeamNetwork {
  return {
    id: record.id,
    teamNumber: record.teamNumber,
    vlanId: record.vlanId,
    ...(record.accessPointId ? { accessPointId: record.accessPointId } : {}),
    ...(record.accessPointSlot
      ? { accessPointSlot: record.accessPointSlot }
      : {}),
    ...(record.credentialRef
      ? { credentialReference: record.credentialRef }
      : {}),
    status: record.status,
    ...(record.statusMessage ? { statusMessage: record.statusMessage } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
