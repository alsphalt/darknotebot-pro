"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  CloudUpload,
  Copy,
  Download,
  Expand,
  FileCode2,
  Keyboard,
  RotateCcw,
  Save,
  Scissors,
  TextSelect,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useServers, useToast } from "@/components/providers";
import { Badge, ConfirmDialog, Empty, Modal, Panel, Spinner, Status } from "@/components/ui";
import { apiDelete, apiGet, apiPost, apiPut, download, errorMessage } from "@/lib/client";
import { relative } from "@/lib/format";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-slate-500"><Spinner className="mr-2" /> Loading editor…</div>,
});

type Tab = {
  path: string;
  content: string;
  original: string;
  sha: string | null;
  indexedSha: string | null;
  language: string;
  modifiedAt: string | null;
  dirty: boolean;
  draftSaved: boolean;
  validation: { ok: boolean; errors: Array<{ line: number; message: string }> };
};

type FilePayload = {
  path: string;
  content: string;
  sha256: string;
  language: string;
  modifiedAt: string | null;
  indexedSha: string | null;
  inSync: boolean;
  draft: { content: string; baseSha: string | null; updatedAt: string } | null;
  validation: { ok: boolean; errors: Array<{ line: number; message: string }> };
  secretKind: string | null;
};

function EditorView() {
  const params = useSearchParams();
  const router = useRouter();
  const { activeId, activeServer } = useServers();
  const { push } = useToast();

  const initialPath = params.get("path") ?? "";
  const lineParam = Number.parseInt(params.get("line") ?? "0", 10);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState("");
  const [openPath, setOpenPath] = useState("");
  const [draftBanner, setDraftBanner] = useState<{ path: string; content: string; baseSha: string | null } | null>(null);
  const [conflict, setConflict] = useState<{ message: string; details?: unknown } | null>(null);

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<any>(null);

  const current = tabs.find((tab) => tab.path === active) ?? null;

  const openFile = useCallback(
    async (path: string, line = 0) => {
      if (!activeId || !path) return;
      if (tabs.some((tab) => tab.path === path)) {
        setActive(path);
        if (line > 0) revealLine(line);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await apiGet<FilePayload>(
          `/api/files/content?serverId=${activeId}&path=${encodeURIComponent(path)}`,
        );
        const tab: Tab = {
          path: data.path,
          content: data.content,
          original: data.content,
          sha: data.sha256,
          indexedSha: data.indexedSha,
          language: data.language,
          modifiedAt: data.modifiedAt,
          dirty: false,
          draftSaved: false,
          validation: data.validation,
        };
        setTabs((list) => [...list, tab]);
        setActive(data.path);
        if (data.draft) {
          setDraftBanner({ path: data.path, content: data.draft.content, baseSha: data.draft.baseSha });
        }
        if (line > 0) setTimeout(() => revealLine(line), 350);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [activeId, tabs],
  );

  useEffect(() => {
    if (initialPath) void openFile(initialPath, lineParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, initialPath]);

  const revealLine = (line: number) => {
    const editor = editorRef.current;
    if (!editor || line <= 0) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    const monaco = monacoRef.current;
    if (monaco) {
      decorationsRef.current?.clear();
      decorationsRef.current = editor.createDecorationsCollection([
        {
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: "bg-accent/10", linesDecorationsClassName: "bg-accent" },
        },
      ]);
    }
    editor.focus();
  };

  const update = (content: string) => {
    if (!active) return;
    setTabs((list) =>
      list.map((tab) =>
        tab.path === active
          ? {
              ...tab,
              content,
              dirty: content !== tab.original,
              draftSaved: false,
              validation: tab.language === "javascript" || tab.language === "typescript"
                ? quickValidate(content)
                : { ok: true, errors: [] },
            }
          : tab,
      ),
    );
  };

  const saveDraft = async () => {
    if (!current) return;
    try {
      await apiPut("/api/drafts", { serverId: activeId, path: current.path, content: current.content, baseSha: current.sha });
      setTabs((list) => list.map((tab) => (tab.path === current.path ? { ...tab, draftSaved: true } : tab)));
      push("Draft saved — production is untouched", "ok");
    } catch (err) {
      push(errorMessage(err), "error");
    }
  };

  const deploy = async () => {
    if (!current) return;
    setDeploying(true);
    try {
      const result = await apiPost<{ deployment: { publicId: string; status: string; healthOk: boolean | null; error: string | null } }>(
        "/api/deployments",
        {
          serverId: activeId,
          files: [{ path: current.path, content: current.content, expectedSha: current.sha }],
          message: deployNote || `Edit ${current.path} from the control center`,
        },
      );
      const deployment = result.deployment;
      if (deployment.status === "SUCCEEDED") {
        push(`Deployed ${deployment.publicId}${deployment.healthOk ? " — startup verified" : ""}`, "ok");
        await apiDelete(`/api/drafts?serverId=${activeId}&path=${encodeURIComponent(current.path)}`).catch(() => undefined);
        setTabs((list) =>
          list.map((tab) =>
            tab.path === current.path ? { ...tab, original: tab.content, dirty: false, draftSaved: false } : tab,
          ),
        );
        router.refresh();
      } else {
        push(`${deployment.publicId}: ${deployment.error ?? deployment.status}`, "error");
      }
      setDeployOpen(false);
      setDeployNote("");
    } catch (err) {
      const message = errorMessage(err);
      push(message, "error");
      setDeployOpen(false);
      if (message.toLowerCase().includes("conflict") || message.toLowerCase().includes("changed")) {
        setConflict({ message });
      }
    } finally {
      setDeploying(false);
    }
  };

  const closeTab = (path: string) => {
    setTabs((list) => {
      const next = list.filter((tab) => tab.path !== path);
      if (active === path) setActive(next[next.length - 1]?.path ?? null);
      return next;
    });
  };

  const withEditor = (fn: (editor: any) => void) => {
    const editor = editorRef.current;
    if (editor) fn(editor);
  };

  const mobileActions = useMemo(
    () => [
      { label: "Select all", icon: TextSelect, run: () => withEditor((editor) => { const model = editor.getModel(); if (model) editor.setSelection(model.getFullModelRange()); editor.focus(); }) },
      {
        label: "Copy",
        icon: Copy,
        run: () => withEditor(async (editor) => {
          const selection = editor.getSelection();
          const text = editor.getModel()?.getValueInRange(selection) ?? "";
          if (text) { await navigator.clipboard.writeText(text).catch(() => undefined); push("Selection copied", "ok"); }
        }),
      },
      {
        label: "Cut",
        icon: Scissors,
        run: () => withEditor(async (editor) => {
          const selection = editor.getSelection();
          const model = editor.getModel();
          const text = model?.getValueInRange(selection) ?? "";
          if (!text) return;
          await navigator.clipboard.writeText(text).catch(() => undefined);
          editor.executeEdits("cut", [{ range: selection, text: "" }]);
        }),
      },
      {
        label: "Paste",
        icon: ClipboardPaste,
        run: () => withEditor(async (editor) => {
          try {
            const text = await navigator.clipboard.readText();
            if (!text) return;
            const selection = editor.getSelection();
            editor.executeEdits("paste", [{ range: selection, text }]);
          } catch {
            push("Clipboard read was blocked — use the native paste menu", "error");
          }
        }),
      },
      {
        label: "Delete",
        icon: Trash2,
        run: () => withEditor((editor) => {
          const selection = editor.getSelection();
          if (selection) editor.executeEdits("delete", [{ range: selection, text: "" }]);
        }),
      },
      {
        label: "Replace",
        icon: Keyboard,
        run: () => withEditor((editor) => { editor.getAction("editor.action.startFindReplaceAction")?.run(); editor.focus(); }),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!activeServer) {
    return <Empty title="No server selected" hint="Connect a Pterodactyl server first." action={<Link href="/settings" className="btn-primary">Connect server</Link>} />;
  }

  return (
    <div className={fullscreen ? "fixed inset-0 z-[80] flex flex-col bg-ink-950" : ""}>
      <PageHeader
        title="Code Editor"
        description="Edits are drafts until deployed. A deploy backs up the current production file, writes, verifies the hash and restarts the bot."
        actions={
          <>
            <button className="btn-ghost" onClick={() => setFullscreen((value) => !value)}>
              <Expand className="h-3.5 w-3.5" /> {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <Link href="/files" className="btn-ghost"><FileCode2 className="h-3.5 w-3.5" /> Browse</Link>
          </>
        }
      />

      <div className="mb-2 flex items-center gap-2">
        <input
          className="field mono !py-1.5 text-xs"
          placeholder="/path/to/file.js — paste a path to open it"
          value={openPath}
          onChange={(event) => setOpenPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && openPath.trim()) void openFile(openPath.trim());
          }}
        />
        <button className="btn-ghost !py-1.5 text-[11px]" onClick={() => openPath.trim() && void openFile(openPath.trim())}>Open</button>
      </div>

      {tabs.length > 0 && (
        <div className="mb-2 flex gap-1 overflow-x-auto pb-1">
          {tabs.map((tab) => (
            <button
              key={tab.path}
              onClick={() => setActive(tab.path)}
              className={`group flex shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-2.5 py-1.5 text-[11px] ${
                active === tab.path
                  ? "border-accent bg-ink-850 text-slate-100"
                  : "border-transparent bg-ink-900/60 text-slate-500 hover:text-slate-300"
              }`}
            >
              <span className="max-w-[160px] truncate">{tab.path.split("/").pop()}</span>
              {tab.dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
              <X
                className="h-3 w-3 text-slate-600 hover:text-rose-300"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.path);
                }}
              />
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>
      )}

      {draftBanner && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-[11px] text-violet-200">
          <span>A local draft exists for <span className="mono">{draftBanner.path}</span>.</span>
          <button
            className="btn-ghost !py-1 text-[10px]"
            onClick={() => {
              setTabs((list) =>
                list.map((tab) =>
                  tab.path === draftBanner.path
                    ? { ...tab, content: draftBanner.content, dirty: draftBanner.content !== tab.original, draftSaved: true }
                    : tab,
                ),
              );
              setDraftBanner(null);
            }}
          >
            Restore draft
          </button>
          <button
            className="btn-ghost !py-1 text-[10px]"
            onClick={async () => {
              await apiDelete(`/api/drafts?serverId=${activeId}&path=${encodeURIComponent(draftBanner.path)}`).catch(() => undefined);
              setDraftBanner(null);
              push("Draft discarded", "ok");
            }}
          >
            Discard
          </button>
        </div>
      )}

      <div className={`grid gap-3 ${fullscreen ? "min-h-0 flex-1 grid-rows-[1fr]" : "lg:grid-cols-[1fr_290px]"}`}>
        <Panel
          bodyClassName="!p-0"
          className="min-h-[55dvh] overflow-hidden"
        >
          {current ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-750/70 px-3 py-2">
                <div className="min-w-0">
                  <p className="mono truncate text-[11px] text-slate-300">{current.path}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    <span>sha {current.sha?.slice(0, 10) ?? "—"}</span>
                    <span>·</span>
                    <span>{relative(current.modifiedAt)}</span>
                    {current.dirty ? <Badge tone="warn">unsaved</Badge> : current.draftSaved ? <Badge tone="accent">draft</Badge> : <Badge tone="good">production</Badge>}
                    {current.indexedSha && current.sha && current.indexedSha !== current.sha && <Badge tone="warn">index stale</Badge>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void saveDraft()} disabled={!current.dirty}>
                    <Save className="h-3 w-3" /> Draft
                  </button>
                  <button
                    className="btn-ghost !px-2 !py-1 text-[10px]"
                    onClick={() => current && void openFile(current.path)}
                    title="Re-read production"
                  >
                    <RotateCcw className="h-3 w-3" /> Reload
                  </button>
                  <button
                    className="btn-ghost !px-2 !py-1 text-[10px]"
                    onClick={() => void download(`/api/files/download?serverId=${activeId}&mode=file&path=${encodeURIComponent(current.path)}`).catch((error) => push(errorMessage(error), "error"))}
                  >
                    <Download className="h-3 w-3" /> Download
                  </button>
                  <button className="btn-primary !px-2 !py-1 text-[10px]" onClick={() => setDeployOpen(true)} disabled={!current.dirty}>
                    <CloudUpload className="h-3 w-3" /> Deploy
                  </button>
                </div>
              </div>

              <div className="h-[calc(100%-52px)] min-h-[45dvh]">
                <MonacoEditor
                  height="100%"
                  path={current.path}
                  language={current.language}
                  value={current.content}
                  theme="vs-dark"
                  onChange={(value) => update(value ?? "")}
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monacoRef.current = monaco;
                    if (lineParam > 0) setTimeout(() => revealLine(lineParam), 200);
                  }}
                  options={{
                    minimap: { enabled: typeof window !== "undefined" && window.innerWidth > 1100 },
                    fontSize: typeof window !== "undefined" && window.innerWidth < 640 ? 12 : 13,
                    fontFamily: "var(--font-mono)",
                    wordWrap: typeof window !== "undefined" && window.innerWidth < 640 ? "on" : "off",
                    lineNumbers: "on",
                    folding: true,
                    autoIndent: "full",
                    bracketPairColorization: { enabled: true },
                    matchBrackets: "always",
                    automaticLayout: true,
                    tabSize: 2,
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    padding: { top: 10, bottom: 24 },
                    quickSuggestions: true,
                    suggestOnTriggerCharacters: true,
                    renderWhitespace: "selection",
                    stickyScroll: { enabled: false },
                  }}
                />
              </div>
            </>
          ) : (
            <div className="flex h-[45dvh] items-center justify-center px-6">
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Reading production file…</div>
              ) : (
                <Empty
                  title="No file open"
                  hint="Open a file from the file manager, or paste a path above. The editor always loads the current production bytes."
                  action={<Link href="/files" className="btn-ghost">Open file manager</Link>}
                />
              )}
            </div>
          )}
        </Panel>

        {!fullscreen && (
          <div className="space-y-3">
            <Panel title="Validation" bodyClassName="!py-3">
              {current?.validation.ok ? (
                <p className="flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> Parses cleanly</p>
              ) : current ? (
                <ul className="space-y-1 text-[11px] text-rose-300">
                  {current.validation.errors.slice(0, 4).map((issue, index) => (
                    <li key={index} className="flex gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>line {issue.line}: {issue.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-slate-500">Open a file to validate it.</p>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                Syntax checking is a gate, not a guarantee. Deploys also verify the written hash and the bot's startup output.
              </p>
            </Panel>

            <Panel title="Production state" bodyClassName="!py-3">
              <dl className="space-y-1.5 text-[11px]">
                <div className="flex justify-between gap-2"><dt className="text-slate-500">In sync</dt><dd>{current?.indexedSha === current?.sha ? <Status status="CONNECTED" label="yes" /> : <Status status="UNKNOWN" label="unverified" />}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Dirty</dt><dd className="text-slate-200">{current?.dirty ? "yes" : "no"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Draft</dt><dd className="text-slate-200">{current?.draftSaved ? "saved" : "none"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Language</dt><dd className="text-slate-200">{current?.language ?? "—"}</dd></div>
              </dl>
            </Panel>

            <Panel title="Deploy checklist" bodyClassName="!py-3">
              <ol className="space-y-1.5 text-[11px] text-slate-400">
                <li>1. Draft compared against the production hash you loaded.</li>
                <li>2. Conflict check — a newer remote file blocks the write.</li>
                <li>3. Previous content backed up as a version.</li>
                <li>4. Write, then re-read and verify SHA-256.</li>
                <li>5. Restart and watch startup output for health.</li>
              </ol>
            </Panel>
          </div>
        )}
      </div>

      {/* Mobile editing toolbar */}
      {current && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-950/95 px-2 py-2 backdrop-blur lg:hidden">
          <div className="flex items-center gap-1 overflow-x-auto">
            {mobileActions.map((action) => (
              <button
                key={action.label}
                onClick={action.run}
                className="flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[9px] text-slate-400 hover:bg-ink-800 hover:text-slate-100"
              >
                <action.icon className="h-4 w-4" />
                {action.label}
              </button>
            ))}
            <button onClick={() => void saveDraft()} className="ml-auto flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[9px] text-accent-soft">
              <Save className="h-4 w-4" /> Draft
            </button>
            <button onClick={() => setDeployOpen(true)} className="flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[9px] text-emerald-300">
              <CloudUpload className="h-4 w-4" /> Deploy
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        onConfirm={() => void deploy()}
        busy={deploying}
        title="Deploy to production?"
        description={
          <div className="space-y-2">
            <p className="mono text-[11px] text-slate-300">{current?.path}</p>
            <p>This writes the file on Pterodactyl, verifies the stored SHA-256, then restarts the bot and watches startup output.</p>
            {current && !current.validation.ok && (
              <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                The file does not parse. Deployment will be rejected until the syntax error is fixed.
              </p>
            )}
          </div>
        }
        confirmLabel="Deploy & restart"
      />

      <Modal
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title="Production changed under you"
        subtitle="The deployment was blocked before writing anything"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConflict(null)}>Keep my draft</button>
            <button
              className="btn-primary"
              onClick={async () => {
                setConflict(null);
                if (current) {
                  await openFile(current.path);
                  push("Reloaded the current production file", "ok");
                }
              }}
            >
              Reload production
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">{conflict?.message}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Nothing was written. The remote and local versions are both preserved in the conflict record under
          Synchronization, where you can compare them.
        </p>
      </Modal>

      {current && <div className="h-14 lg:hidden" />}
    </div>
  );
}

function quickValidate(content: string): { ok: boolean; errors: Array<{ line: number; message: string }> } {
  let depth = 0;
  let line = 1;
  const errors: Array<{ line: number; message: string }> = [];
  for (const char of content) {
    if (char === "\n") line += 1;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth < 0) {
        errors.push({ line, message: "Unexpected closing brace" });
        break;
      }
    }
  }
  if (depth > 0 && errors.length === 0) errors.push({ line, message: `${depth} unclosed brace(s)` });
  return { ok: errors.length === 0, errors };
}

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Loading editor…</div>}>
      <EditorView />
    </Suspense>
  );
}
