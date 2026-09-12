import { z } from "zod";

export const teamNumberSchema = z.number().int().min(1).max(99_999);

export const teamNetworkStatusSchema = z.enum([
  "provisioning",
  "waiting-for-robot",
  "online",
  "offline",
  "error",
]);

export const teamNetworkSchema = z.object({
  id: z.string().min(1),
  teamNumber: z.number().int().positive(),
  vlanId: z.number().int().min(1).max(4094),
  accessPointId: z.string().min(1).optional(),
  accessPointSlot: z.string().min(1).optional(),
  credentialReference: z.string().min(1).optional(),
  status: teamNetworkStatusSchema,
  statusMessage: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const teamNetworkCreateSchema = z.object({
  teamNumber: teamNumberSchema,
  accessPointId: z.string().min(1).optional(),
  accessPointSlot: z.string().min(1).optional(),
  credentialReference: z.string().min(1).optional(),
});
export const createTeamNetworkSchema = teamNetworkCreateSchema;

export const applicationPortRoleSchema = z.enum([
  "client",
  "ap-trunk",
  "server",
  "management",
  "unused",
]);

export const portAssignmentSchema = z.object({
  switchId: z.string().min(1),
  portId: z.string().min(1),
  teamNetworkId: z.string().min(1).optional(),
  role: applicationPortRoleSchema,
  label: z.string().optional(),
  updatedAt: z.string().datetime(),
});

export const portAssignSchema = z.object({
  switchId: z.string().min(1),
  portId: z.string().min(1),
  teamNetworkId: z.string().min(1).optional(),
  role: applicationPortRoleSchema.optional(),
  label: z.string().max(200).optional(),
  bounce: z.boolean().optional(),
});
export const assignPortSchema = portAssignSchema;

export const networkConfigurationSchema = z
  .object({
    managementVlan: z.number().int().min(1).max(4094),
    onboardingVlan: z.number().int().min(1).max(4094),
    teamVlanStart: z.number().int().min(1).max(4094),
    teamVlanEnd: z.number().int().min(1).max(4094),
    portBounceDelayMs: z.number().int().nonnegative().max(60_000),
  })
  .refine((value) => value.managementVlan !== value.onboardingVlan, {
    message: "Management and onboarding VLANs must be different",
  })
  .refine((value) => value.teamVlanStart <= value.teamVlanEnd, {
    message: "The team VLAN range start must not exceed its end",
  });

export const installationConfigSchema = networkConfigurationSchema;
export const configSchema = installationConfigSchema;

export const portalConnectSchema = z.object({
  teamNumber: teamNumberSchema,
  /** Optional for simulated clients; production derives this from the HTTP request. */
  ip: z.union([z.ipv4(), z.ipv6()]).optional(),
});
export const portalConnectRequestSchema = portalConnectSchema;

export const dhcpLeaseSchema = z.object({
  ip: z.union([z.ipv4(), z.ipv6()]),
  mac: z.string().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i),
  vlanId: z.number().int().min(1).max(4094).optional(),
  hostname: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

export type TeamNetworkInput = Pick<
  import("./domain.js").TeamNetwork,
  | "teamNumber"
  | "vlanId"
  | "accessPointId"
  | "accessPointSlot"
  | "credentialReference"
  | "status"
>;

export type TeamNetworkCreateRequest = z.infer<typeof teamNetworkCreateSchema>;
export type PortAssignRequest = z.infer<typeof portAssignSchema>;
export type PortalConnectRequest = z.infer<typeof portalConnectSchema>;
export type InstallationConfigInput = z.infer<typeof installationConfigSchema>;
