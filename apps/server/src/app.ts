import cors from "@fastify/cors";
import {
  applicationPortRoleSchema,
  dhcpLeaseSchema,
  networkConfigurationSchema,
  portalConnectSchema,
  teamNumberSchema,
} from "@repo/core";
import type { AccessPointStationStatus } from "@repo/ap";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import type { AppContext } from "./context.js";
import { DomainError } from "./networking/errors.js";

const createTeamSchema = z.object({
  teamNumber: teamNumberSchema,
  accessPointId: z.string().min(1).optional(),
  accessPointSlot: z.string().min(1).optional(),
  ssid: z.string().min(1).max(32).optional(),
  wpaKey: z.string().min(8).max(63).optional(),
});
const portPatchSchema = z.object({
  teamNetworkId: z.string().min(1).nullable().optional(),
  role: applicationPortRoleSchema.optional(),
  label: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});
const availabilitySchema = z.object({ available: z.boolean() });
const portSimulationSchema = z.object({
  enabled: z.boolean().optional(),
  linkUp: z.boolean().optional(),
  mac: z
    .string()
    .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i)
    .optional(),
  vlanId: z.number().int().min(1).max(4094).optional(),
  clearMacs: z.boolean().optional(),
});
const stationSimulationSchema = z.object({
  associated: z.boolean().optional(),
  mac: z
    .string()
    .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i)
    .optional(),
  signalStrengthDbm: z.number().int().min(-120).max(0).optional(),
});
const failureSimulationSchema = z.object({
  hardware: z.enum(["switch", "access-point"]),
  id: z.string().min(1).optional(),
  operation: z.string().min(1),
  message: z.string().max(300).nullable().optional(),
});
const resetSimulationSchema = z.object({
  mode: z.enum(["hardware-to-desired", "seeded-demo"]).optional(),
  scope: z.enum(["hardware", "demo"]).optional(),
});
const overviewCacheTtlMs = 5_000;

function clientIp(
  request: FastifyRequest,
  supplied: string | undefined,
  allowSimulationOverrides: boolean,
): string {
  const simulated = request.headers["x-simulated-client-ip"];
  return (
    (allowSimulationOverrides ? supplied : undefined) ??
    (allowSimulationOverrides && typeof simulated === "string"
      ? simulated
      : request.ip.replace(/^::ffff:/, ""))
  );
}

function publicStation(
  status: AccessPointStationStatus,
): AccessPointStationStatus {
  return status.configuration
    ? {
        ...status,
        configuration: { ...status.configuration, wpaKey: undefined },
      }
    : status;
}

export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    trustProxy: context.mode === "production" ? ["127.0.0.1"] : false,
  });
  await app.register(cors, { origin: true });

  type Overview = Awaited<ReturnType<typeof buildOverview>>;
  let overviewCache: { value: Overview; cachedAt: number } | undefined;
  let overviewRefresh: Promise<Overview> | undefined;
  let overviewGeneration = 0;
  const refreshOverview = (): Promise<Overview> => {
    if (overviewRefresh) return overviewRefresh;
    const generation = overviewGeneration;
    const refresh = buildOverview(context)
      .then((value) => {
        if (generation === overviewGeneration)
          overviewCache = { value, cachedAt: Date.now() };
        return value;
      })
      .finally(() => {
        if (overviewRefresh === refresh) overviewRefresh = undefined;
      });
    overviewRefresh = refresh;
    return refresh;
  };
  const invalidateOverview = (): void => {
    overviewGeneration += 1;
    overviewCache = undefined;
    overviewRefresh = undefined;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.flatten(),
        },
      });
      return;
    }
    if (error instanceof DomainError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
  });

  app.get("/api/health", async () => {
    const hardware = await Promise.all([
      ...context.hardware.listSwitches().map(async ([id, value]) => {
        try {
          await value.getInfo();
          return { id, kind: "switch", available: true };
        } catch {
          return { id, kind: "switch", available: false };
        }
      }),
      ...context.hardware.listAccessPoints().map(async ([id, value]) => {
        try {
          await value.getInfo();
          return { id, kind: "access-point", available: true };
        } catch {
          return { id, kind: "access-point", available: false };
        }
      }),
    ]);
    return {
      status: hardware.every((item) => item.available) ? "ok" : "degraded",
      mode: context.mode,
      hardware,
    };
  });

  app.get("/api/config", async () => context.repository.getConfig());
  app.put("/api/config", async (request) => {
    const config = context.repository.updateConfig(
      networkConfigurationSchema.parse(request.body),
    );
    invalidateOverview();
    return config;
  });

  app.get("/api/overview", async (_request, reply) => {
    reply.header(
      "cache-control",
      "private, max-age=2, stale-while-revalidate=30",
    );
    if (!overviewCache) {
      reply.header("x-field-manager-cache", "miss");
      return refreshOverview();
    }
    if (Date.now() - overviewCache.cachedAt <= overviewCacheTtlMs) {
      reply.header("x-field-manager-cache", "hit");
      return overviewCache.value;
    }
    reply.header("x-field-manager-cache", "stale");
    void refreshOverview().catch((error) => {
      app.log.warn({ error }, "Background overview refresh failed");
    });
    return overviewCache.value;
  });

  app.get("/api/team-networks", async () =>
    context.teams.list().map((team) => ({
      ...team,
      wiredPorts: context.ports.listForTeam(team.id),
    })),
  );
  app.get<{ Params: { id: string } }>(
    "/api/team-networks/:id",
    async (request) => {
      const team = context.teams.get(request.params.id);
      return { ...team, wiredPorts: context.ports.listForTeam(team.id) };
    },
  );
  app.post("/api/team-networks", async (request, reply) => {
    const team = await context.teams.create(
      createTeamSchema.parse(request.body),
    );
    invalidateOverview();
    return reply.status(201).send({ ...team, wiredPorts: [] });
  });
  app.delete<{ Params: { id: string } }>(
    "/api/team-networks/:id",
    async (request, reply) => {
      await context.teams.remove(request.params.id);
      invalidateOverview();
      return reply.status(204).send();
    },
  );

  app.get("/api/switches", async () => getSwitches(context));
  app.get<{ Params: { id: string } }>(
    "/api/switches/:id/ports",
    async (request) => getPorts(context, request.params.id),
  );
  app.get<{ Params: { id: string; portId: string } }>(
    "/api/switches/:id/ports/:portId",
    async (request) => {
      const response = await getPorts(context, request.params.id);
      const port = response.ports.find(
        (item) => item.id === request.params.portId,
      );
      if (!port)
        throw new DomainError(
          "NOT_FOUND",
          `Port ${request.params.portId} was not found`,
          404,
        );
      return port;
    },
  );
  app.patch<{ Params: { id: string; portId: string } }>(
    "/api/switches/:id/ports/:portId",
    async (request) => {
      const body = portPatchSchema.parse(request.body);
      const { id, portId } = request.params;
      if (body.teamNetworkId !== undefined) {
        if (body.teamNetworkId === null)
          await context.ports.returnToOnboarding(id, portId);
        else
          await context.ports.assignToTeam(id, portId, body.teamNetworkId, {
            label: body.label ?? undefined,
          });
      }
      if (body.role)
        await context.ports.setRole(
          id,
          portId,
          body.role,
          body.label ?? undefined,
        );
      if (body.enabled !== undefined)
        await context.ports.setEnabled(id, portId, body.enabled);
      const refreshed = await getPorts(context, id);
      invalidateOverview();
      return refreshed.ports.find((port) => port.id === portId);
    },
  );
  app.post<{ Params: { id: string; portId: string } }>(
    "/api/switches/:id/ports/:portId/bounce",
    async (request, reply) => {
      await context.ports.bounce(request.params.id, request.params.portId);
      invalidateOverview();
      return reply.status(204).send();
    },
  );

  app.get("/api/access-points", async () => getAccessPoints(context));
  app.get("/api/reconciliation", async () => context.health.inspect());

  app.get("/api/portal/session", async (request) => {
    const query = z
      .object({ ip: z.union([z.ipv4(), z.ipv6()]).optional() })
      .parse(request.query);
    return context.portal.getSession(
      clientIp(request, query.ip, context.mode === "mock"),
    );
  });
  app.post("/api/portal/connect", async (request) => {
    const body = portalConnectSchema.parse(request.body);
    const result = await context.portal.connect(
      clientIp(request, body.ip, context.mode === "mock"),
      body.teamNumber,
    );
    invalidateOverview();
    return result;
  });

  if (context.simulation) {
    const simulation = context.simulation;
    app.get("/api/dev/state", async () => simulation.state());
    app.post<{ Params: { id: string } }>(
      "/api/dev/switches/:id/availability",
      async (request) => {
        const body = availabilitySchema.parse(request.body);
        simulation.setSwitchAvailability(request.params.id, body.available);
        invalidateOverview();
        return body;
      },
    );
    app.post<{ Params: { id: string; portId: string } }>(
      "/api/dev/switches/:id/ports/:portId",
      async (request) => {
        const body = portSimulationSchema.parse(request.body);
        const port = await simulation.simulatePort(
          request.params.id,
          request.params.portId,
          body,
        );
        invalidateOverview();
        return port;
      },
    );
    app.post<{ Params: { id: string } }>(
      "/api/dev/access-points/:id/availability",
      async (request) => {
        const body = availabilitySchema.parse(request.body);
        simulation.setAccessPointAvailability(
          request.params.id,
          body.available,
        );
        invalidateOverview();
        return body;
      },
    );
    app.post<{ Params: { id: string; slotId: string } }>(
      "/api/dev/access-points/:id/stations/:slotId",
      async (request) => {
        const body = stationSimulationSchema.parse(request.body);
        const station = await simulation.simulateStation(
          request.params.id,
          request.params.slotId,
          body,
        );
        invalidateOverview();
        return station;
      },
    );
    app.post("/api/dev/dhcp/leases", async (request, reply) => {
      const lease = simulation.createLease(dhcpLeaseSchema.parse(request.body));
      invalidateOverview();
      return reply.status(201).send(lease);
    });
    app.delete<{ Params: { ip: string } }>(
      "/api/dev/dhcp/leases/:ip",
      async (request, reply) => {
        simulation.deleteLease(request.params.ip);
        invalidateOverview();
        return reply.status(204).send();
      },
    );
    app.post("/api/dev/failures", async (request) => {
      const body = failureSimulationSchema.parse(request.body);
      simulation.setFailure(
        body.hardware,
        body.operation,
        body.message ?? undefined,
        body.id,
      );
      invalidateOverview();
      return {
        hardware: body.hardware,
        operation: body.operation,
        enabled: body.message !== null && body.message !== undefined,
      };
    });
    app.post("/api/dev/reset", async (request) => {
      const body = resetSimulationSchema.parse(request.body ?? {});
      const mode =
        body.mode ??
        (body.scope === "demo" ? "seeded-demo" : "hardware-to-desired");
      const result = await simulation.reset(mode);
      invalidateOverview();
      return result;
    });
  }

  return app;
}

async function buildOverview(context: AppContext) {
  const [teamNetworks, switchSummaries, accessPointDetails, reconciliation] =
    await Promise.all([
      context.teams.refreshStatuses(),
      getSwitches(context),
      getAccessPoints(context),
      context.health.inspect(),
    ]);
  const switches = await Promise.all(
    switchSummaries
      .filter((item) => item.available)
      .map(async (summary) => {
        const detail = await getPorts(context, summary.id);
        return {
          ...detail.switch,
          managementAddress: detail.switch.managementAddress ?? "",
          ports: detail.ports,
        };
      }),
  );
  const allPorts = switches.flatMap((item) => item.ports);
  return {
    config: context.repository.getConfig(),
    teamNetworks: teamNetworks.map((team) => ({
      ...team,
      robotOnline: team.status === "online",
      ports: allPorts
        .filter((port) => port.teamNetworkId === team.id)
        .map((port) => ({
          portId: port.id,
          label: port.label,
          linkUp: port.linkUp,
          mac: port.learnedMacs[0]?.mac,
        })),
    })),
    switches,
    accessPoints: accessPointDetails.map((item) => {
      if (!item.available || !item.info || !item.stations) {
        return {
          id: item.id,
          name: item.id,
          availableSlots: 0,
          online: false,
        };
      }
      return {
        id: item.id,
        name: item.info.name,
        managementAddress: item.info.managementAddress,
        availableSlots: item.stations.filter(
          (station) => station.state === "available",
        ).length,
        online: true,
        stations: item.stations,
      };
    }),
    reconciliation,
  };
}

async function getSwitches(context: AppContext) {
  return Promise.all(
    context.hardware.listSwitches().map(async ([id, managedSwitch]) => {
      try {
        return {
          id,
          info: await managedSwitch.getInfo(),
          capabilities: await managedSwitch.getCapabilities(),
          available: true,
        };
      } catch (error) {
        return { id, available: false, error: String(error) };
      }
    }),
  );
}

async function getAccessPoints(context: AppContext) {
  return Promise.all(
    context.hardware.listAccessPoints().map(async ([id, accessPoint]) => {
      try {
        const info = await accessPoint.getInfo();
        const capabilities = await accessPoint.getCapabilities();
        const stations = await Promise.all(
          capabilities.slotIds.map(async (slotId) =>
            publicStation(await accessPoint.getStationStatus(slotId)),
          ),
        );
        return { id, info, capabilities, stations, available: true };
      } catch (error) {
        return { id, available: false, error: String(error) };
      }
    }),
  );
}

async function getPorts(context: AppContext, switchId: string) {
  const managedSwitch = context.hardware.getSwitch(switchId);
  const [info, ports, macTable] = await Promise.all([
    managedSwitch.getInfo(),
    managedSwitch.getPorts(),
    managedSwitch.getMacTable(),
  ]);
  const assignments = new Map(
    context.repository
      .listPortAssignments(switchId)
      .map((item) => [item.portId, item]),
  );
  const teams = new Map(
    context.repository.listTeamNetworks().map((item) => [item.id, item]),
  );
  return {
    switch: info,
    ports: ports.map((port) => {
      const assignment = assignments.get(port.id);
      const team = assignment?.teamNetworkId
        ? teams.get(assignment.teamNetworkId)
        : undefined;
      const learnedMacs = macTable.filter((entry) => entry.portId === port.id);
      return {
        ...port,
        role: assignment?.role ?? port.role,
        label: assignment?.label,
        teamNetworkId: team?.id,
        teamNumber: team?.teamNumber,
        learnedMacs,
        macs: learnedMacs.map((entry) => entry.mac),
      };
    }),
  };
}
