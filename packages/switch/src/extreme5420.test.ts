import { describe, expect, it } from "vitest";
import {
  Extreme5420Switch,
  SwitchEngineJsonRpcTransport,
  type SwitchEngineCliTransport,
} from "./extreme5420.js";

interface FakePort {
  enabled: boolean;
  linkUp: boolean;
  speedMbps?: number;
  untagged?: number;
  tagged: number[];
}

class FakeSwitchEngine implements SwitchEngineCliTransport {
  readonly commands: string[] = [];
  readonly vlans = new Set([1, 100, 999]);
  readonly ports = new Map<string, FakePort>([
    [
      "1",
      {
        enabled: true,
        linkUp: true,
        speedMbps: 1_000,
        untagged: 999,
        tagged: [],
      },
    ],
    [
      "52",
      {
        enabled: true,
        linkUp: true,
        speedMbps: 25_000,
        untagged: 100,
        tagged: [],
      },
    ],
  ]);
  readonly fdb = [
    "00:57:12:00:00:01 vlan30(0030) 0041 d m 1",
    "AA:BB:CC:DD:EE:FF onboarding(0999) 0099 d m 1",
  ];

  async execute(commands: readonly string[]): Promise<string[]> {
    const outputs: string[] = [];
    for (const command of commands) {
      this.commands.push(command);
      if (command === "show switch") {
        outputs.push(
          "System Type: 5420M-48W-4YE\nImage : Switch Engine version 32.7.1.4",
        );
      } else if (/^show ports .+ information detail$/.test(command)) {
        const ids = command
          .slice("show ports ".length, -" information detail".length)
          .split(",");
        outputs.push(ids.map((id) => this.portDetail(id)).join("\n"));
      } else if (/^show port .+ vid$/.test(command)) {
        const ids = command
          .slice("show port ".length, -" vid".length)
          .split(",");
        outputs.push(ids.map((id) => this.portVids(id)).join("\n"));
      } else if (command === "show vlan") {
        outputs.push(
          [...this.vlans].map((vlan) => `FM-${vlan} ${vlan} ANY`).join("\n"),
        );
      } else if (/^create vlan /.test(command)) {
        this.vlans.add(Number(/ tag (\d+)$/.exec(command)![1]));
      } else if (/^configure vlan \d+ delete ports /.test(command)) {
        const [, vlan, portId] =
          /^configure vlan (\d+) delete ports (\S+)$/.exec(command)!;
        const port = this.ports.get(portId!)!;
        if (port.untagged === Number(vlan)) port.untagged = undefined;
        port.tagged = port.tagged.filter((value) => value !== Number(vlan));
      } else if (/^configure vlan [\d,]+ add ports /.test(command)) {
        const [, vlanList, portId, tagging] =
          /^configure vlan ([\d,]+) add ports (\S+) (tagged|untagged)$/.exec(
            command,
          )!;
        const port = this.ports.get(portId!)!;
        const values = vlanList!.split(",").map(Number);
        if (tagging === "untagged") port.untagged = values[0];
        else port.tagged = values;
      } else if (/^(enable|disable) ports /.test(command)) {
        const [, action, portId] = /^(enable|disable) ports (\S+)$/.exec(
          command,
        )!;
        this.ports.get(portId!)!.enabled = action === "enable";
      } else if (command === "show fdb") {
        outputs.push(this.fdb.join("\n"));
      } else if (/^show fdb ports /.test(command)) {
        const portId = command.split(" ").at(-1)!;
        outputs.push(
          this.fdb.filter((line) => line.endsWith(` ${portId}`)).join("\n"),
        );
      } else if (/^show fdb [0-9A-F:]+$/.test(command)) {
        const mac = command.slice("show fdb ".length);
        outputs.push(
          this.fdb.filter((line) => line.startsWith(mac)).join("\n"),
        );
      }
    }
    return outputs;
  }

  private portDetail(portId: string): string {
    const port = this.ports.get(portId);
    if (!port) return "";
    const speed = port.speedMbps === 25_000 ? "25Gbps" : "1Gbps";
    return `Port: ${portId}\n  Admin state: ${port.enabled ? "Enabled" : "Disabled"} with auto-speed sensing auto-duplex\n  Link State: ${port.linkUp ? `Active, ${speed}, full-duplex` : "Ready"}\n`;
  }

  private portVids(portId: string): string {
    const port = this.ports.get(portId)!;
    return `${portId} Untagged ${port.untagged ?? "None"}\n   Tagged ${port.tagged.length ? port.tagged.join(", ") : "None"}`;
  }
}

function adapter(transport: FakeSwitchEngine) {
  return new Extreme5420Switch({
    info: {
      id: "switch-1",
      name: "Field Switch",
      managementAddress: "10.0.100.3",
    },
    managementVlan: 100,
    onboardingVlan: 999,
    portIds: ["1", "52"],
    clientPorts: ["1"],
    apTrunkPorts: ["52"],
    transport,
    bounceDelayMs: 0,
  });
}

describe("Extreme5420Switch", () => {
  it("reads model, firmware, physical state, and VLAN membership", async () => {
    const transport = new FakeSwitchEngine();
    const sw = adapter(transport);
    expect(await sw.getInfo()).toMatchObject({
      manufacturer: "Extreme Networks",
      model: "5420M-48W-4YE",
      firmwareVersion: "32.7.1.4",
    });
    expect(await sw.getPort("1")).toMatchObject({
      enabled: true,
      linkUp: true,
      speedMbps: 1_000,
      duplex: "full",
      mode: "access",
      accessVlan: 999,
      role: "client",
    });
  });

  it("creates VLANs, configures access and trunk membership, and verifies readback", async () => {
    const transport = new FakeSwitchEngine();
    const sw = adapter(transport);

    await sw.setAccessVlan("1", 30);
    expect(await sw.getPort("1")).toMatchObject({
      mode: "access",
      accessVlan: 30,
    });
    expect(transport.commands).toContain("create vlan FM-30 tag 30");
    expect(transport.commands).toContain(
      "configure vlan 30 add ports 1 untagged",
    );

    await sw.setTrunkVlans("52", [30, 40], 100);
    expect(await sw.getPort("52")).toMatchObject({
      mode: "trunk",
      nativeVlan: 100,
      taggedVlans: [30, 40],
    });
    expect(transport.commands).toContain(
      "configure vlan 30,40 add ports 52 tagged",
    );
  });

  it("normalizes forwarding entries and supports MAC lookup", async () => {
    const sw = adapter(new FakeSwitchEngine());
    expect(await sw.getMacTable()).toEqual([
      {
        mac: "00:57:12:00:00:01",
        portId: "1",
        vlanId: 30,
        dynamic: true,
        ageSeconds: 41,
      },
      {
        mac: "AA:BB:CC:DD:EE:FF",
        portId: "1",
        vlanId: 999,
        dynamic: true,
        ageSeconds: 99,
      },
    ]);
    expect(await sw.findPortByMac("aa-bb-cc-dd-ee-ff")).toBe("1");
  });

  it("enables, disables, bounces, and resets ports", async () => {
    const transport = new FakeSwitchEngine();
    const sw = adapter(transport);
    await sw.setPortEnabled("1", false);
    expect((await sw.getPort("1")).enabled).toBe(false);
    await sw.setPortEnabled("1", true);
    await sw.bouncePort("1", 0);
    expect((await sw.getPort("1")).enabled).toBe(true);
    await sw.resetPort("1");
    expect(await sw.getPort("1")).toMatchObject({
      accessVlan: 999,
      enabled: true,
    });
  });
});

describe("SwitchEngineJsonRpcTransport", () => {
  it("uses the documented JSON-RPC CLI request shape and Basic authentication", async () => {
    let request: { url?: string; init?: RequestInit } = {};
    const transport = new SwitchEngineJsonRpcTransport({
      baseUrl: "10.0.100.3",
      username: "admin",
      password: "secret",
      fetch: async (input, init) => {
        request = { url: String(input), init };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: [{ CLIoutput: "ok" }, { status: "SUCCESS" }],
          }),
        );
      },
    });
    await expect(
      transport.execute(["show switch", "show vlan"]),
    ).resolves.toEqual(["ok"]);
    expect(request.url).toBe("http://10.0.100.3/jsonrpc/");
    expect(new Headers(request.init?.headers).get("authorization")).toBe(
      `Basic ${btoa("admin:secret")}`,
    );
    expect(JSON.parse(String(request.init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "cli",
      params: ["show switch;show vlan"],
    });
  });
});
