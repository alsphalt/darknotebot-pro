"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, AlertTriangle, Play, RefreshCw, Square } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Panel, Spinner, Stat, Status } from "@/components/ui";
import { apiPost, errorMessage } from "@/lib/client";
import { useApi } from "@/lib/use-api";
import { bytes, duration, relative } from "@/lib/format";

type Monitor = {
  checkedAt: string;
  panel: {
    reachable: boolean;
    state: string;
    cpuPercent: number;
    memoryBytes: number;
    memoryLimitBytes: number | null;
    diskBytes: number;
    diskLimitBytes: number | null;
    uptimeMs: number;
    error: string | null;
  };
  bot: { state: string; whatsapp: string; detail: string; evidence: string[] };
  console: { streamState: string; streamError: string | null; lines: Array<{ ts: number; text: string; level: string }> };
  index: { lastScanAt: string | null; lastScanStatus: string | null; lastScanMethod: string };
  sync: { pendingDrafts: number; openConflicts: number };
  deployments: { restarts: number; lastStatus: string | null; lastAt: string | null };
  errors: Array<{ level: string; message: string; at: string; source: string }>;
};

export default function MonitorPage() {
  const { activeId, activeServer } = useServers();
  const { push } = useToast();
  const monitor = useApi<Monitor>(activeId ? `/api/monitor?serverId=${activeId}` : null, { refreshMs: 12_000 });
  const [confirm, setConfirm] = useState<null | "restart" | "start" | "stop">(null);
  const [busy, setBusy] = useState(false);

  const data = monitor.data;

  const power = async (action: "restart" | "start" | "stop") => {
    setBusy(true);
    try {
      await apiPost("/api/monitor", { serverId: activeId, action, confirm: "CONFIRM" });
      push(`${action} signal accepted by the panel`, "ok");
      await monitor.refresh();
    } catch (error) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link className="btn-primary" href="/settings">Connect server</Link>} />;
  }

  return (
    <>
      <PageHeader
        title="Live Monitor"
        description="Container state, WhatsApp connection, resources and console output — read straight from the panel."
        actions={
          <>
            <button className="btn-ghost" onClick={() => void monitor.refresh()} disabled={monitor.loading}>
              {monitor.loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </button>
            <button className="btn-ghost" onClick={() => setConfirm("start")}><Play className="h-3.5 w-3.5" /> Start</button>
            <button className="btn-primary" onClick={() => setConfirm("restart")}><RefreshCw className="h-3.5 w-3.5" /> Restart</button>
            <button className="btn-danger" onClick={() => setConfirm("stop")}><Square className="h-3.5 w-3.5" /> Stop</button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Container" value={<Status status={data?.bot.state ?? "UNKNOWN"} />} hint={data?.panel.state} tone={data?.bot.state === "ONLINE" ? "good" : "warn"} />
        <Stat label="WhatsApp link" value={<Status status={data?.bot.whatsapp ?? "UNKNOWN"} />} hint={data?.bot.whatsapp === "UNKNOWN" ? "no console evidence yet" : "derived from console"} tone={data?.bot.whatsapp === "CONNECTED" ? "good" : data?.bot.whatsapp === "DISCONNECTED" ? "bad" : "default"} />
        <Stat label="CPU" value={data ? `${data.panel.cpuPercent.toFixed(1)}%` : "—"} hint="panel reported" />
        <Stat label="RAM" value={bytes(data?.panel.memoryBytes)} hint={data?.panel.memoryLimitBytes ? `limit ${bytes(data.panel.memoryLimitBytes)}` : "no limit set"} />
      </div>

      {!data?.panel.reachable && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">The panel is not answering.</p>
            <p className="mt-0.5 text-rose-200/80">{data?.panel.error ?? "Check the panel URL and API key in Admin Settings."}</p>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Console tail" subtitle={`stream: ${data?.console.streamState ?? "idle"} · ${data?.console.lines.length ?? 0} lines buffered`} actions={<Link href="/console" className="text-[11px] text-accent-soft hover:underline">Full terminal →</Link>}>
          {data?.console.lines.length ? (
            <div className="code-scroll max-h-[340px] overflow-auto rounded-lg border border-ink-700/70 bg-ink-950/80 px-3 py-2">
              {data.console.lines.slice(-60).map((line, index) => (
                <div key={index} className={line.level === "error" ? "text-rose-300" : line.level === "warn" ? "text-amber-300" : line.level === "system" ? "text-cyber/80" : "text-slate-300"}>
                  {line.text}
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No console output captured" hint="Open the terminal to attach the websocket, or the container may be offline." action={<Link href="/console" className="btn-ghost">Open terminal</Link>} />
          )}
        </Panel>

        <Panel title="Runtime facts">
          <dl className="space-y-2 text-xs">
            <Row label="Uptime" value={duration(data?.panel.uptimeMs)} />
            <Row label="Disk" value={`${bytes(data?.panel.diskBytes)}${data?.panel.diskLimitBytes ? ` / ${bytes(data.panel.diskLimitBytes)}` : ""}`} />
            <Row label="Restarts recorded" value={String(data?.deployments.restarts ?? 0)} />
            <Row label="Last deploy" value={data?.deployments.lastStatus ? <Status status={data.deployments.lastStatus} /> : "none"} />
            <Row label="Last scan" value={relative(data?.index.lastScanAt)} />
            <Row label="Scan method" value={data?.index.lastScanMethod ?? "—"} />
            <Row label="Pending drafts" value={String(data?.sync.pendingDrafts ?? 0)} />
            <Row label="Open conflicts" value={String(data?.sync.openConflicts ?? 0)} />
            <Row label="Checked" value={relative(data?.checkedAt)} />
          </dl>
          <p className="mt-3 rounded-lg border border-ink-700/60 bg-ink-950/50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500">
            A running container does not prove WhatsApp is linked. The WhatsApp state above is inferred only from real
            console lines; with no output it stays <span className="text-slate-300">unknown</span>.
          </p>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Errors & warnings" subtitle="Console errors, panel failures, failed deployments">
          {data?.errors.length ? (
            <ul className="space-y-2">
              {data.errors.map((error, index) => (
                <li key={index} className="rounded-lg border border-ink-700/60 bg-ink-900/50 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <Badge tone={error.source === "console" ? "bad" : "warn"}>{error.source}</Badge>
                    <span className="text-[10px] text-slate-500">{relative(error.at)}</span>
                  </div>
                  <p className="mono mt-1 break-words text-[11px] text-slate-300">{error.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nothing failing right now" hint="Errors surface here the moment the console or a deployment reports one." />
          )}
        </Panel>

        <Panel title="Startup health checks" subtitle="What a deploy waits for before calling the bot healthy">
          <ul className="space-y-2 text-xs text-slate-400">
            <li className="flex gap-2"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" /> Healthy patterns come from the server policy (e.g. “connected to WhatsApp”, “connection open”).</li>
            <li className="flex gap-2"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" /> Failure patterns (SyntaxError, Cannot find module, unhandled rejection) fail the deployment immediately.</li>
            <li className="flex gap-2"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyber" /> Health is judged from the live console after the restart, not from the fact that files were written.</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/settings" className="btn-ghost !py-1.5 text-[11px]">Edit patterns</Link>
            <Link href="/deployments" className="btn-ghost !py-1.5 text-[11px]">Deployment history</Link>
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && void power(confirm)}
        busy={busy}
        danger={confirm === "stop"}
        title={`${confirm ?? "Power"} the server?`}
        description={`The panel will receive a "${confirm}" signal. This acts on the running bot, not on the files.`}
        confirmLabel={`Yes, ${confirm}`}
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-200">{value}</dd>
    </div>
  );
}
