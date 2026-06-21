import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, Loader2, Plus, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type {
  AdminEncounterListItem, ProviderRosterItem, TemplateOut,
} from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

function fmt(ts: string) {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function AdminDashboard() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
      <h1 className="mb-4 text-lg font-semibold tracking-tight">Administration</h1>
      <Tabs defaultValue="encounters">
        <TabsList>
          <TabsTrigger value="encounters">Encounters</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>
        <TabsContent value="encounters"><EncountersTab /></TabsContent>
        <TabsContent value="providers"><ProvidersTab /></TabsContent>
        <TabsContent value="templates"><TemplatesTab /></TabsContent>
      </Tabs>
    </main>
  );
}

// --- Encounters (cross-provider, filtered) ---------------------------------
function EncountersTab() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderRosterItem[]>([]);
  const [rows, setRows] = useState<AdminEncounterListItem[] | null>(null);
  const [providerId, setProviderId] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  function load() {
    setRows(null);
    api.adminEncounters({
      provider_id: providerId === "all" ? undefined : Number(providerId),
      date_from: from || undefined,
      date_to: to || undefined,
    }).then(setRows).catch(() => setRows([]));
  }

  useEffect(() => { api.adminProviders().then(setProviders); }, []);
  useEffect(load, [providerId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mt-3">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Provider</Label>
          <Select value={providerId} onValueChange={setProviderId}>
            <SelectTrigger className="h-8 w-52 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All providers</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={String(p.id)} className="text-xs">{p.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40 text-xs" />
        </div>
        {(from || to || providerId !== "all") && (
          <Button variant="ghost" size="sm" className="h-8 text-xs"
            onClick={() => { setProviderId("all"); setFrom(""); setTo(""); }}>
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Patient</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></TableCell></TableRow>
            )}
            {rows?.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">No encounters match.</TableCell></TableRow>
            )}
            {rows?.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/admin/encounters/${r.id}`)}>
                <TableCell className="font-medium">{r.patient_name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{r.provider_email}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={r.status === "finalized" ? "border-success/40 text-success" : "border-warning/40 text-warning"}>
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.current_version_no ? `v${r.current_version_no}` : "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmt(r.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// --- Providers -------------------------------------------------------------
function ProvidersTab() {
  const [rows, setRows] = useState<ProviderRosterItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"provider" | "admin">("provider");
  const [busy, setBusy] = useState(false);
  // The one-time temporary password is held here so it can be shown inside the
  // dialog after creation (it is never retrievable again).
  const [created, setCreated] = useState<{ email: string; temp_password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function load() { api.adminProviders().then(setRows); }
  useEffect(load, []);

  function resetDialog() {
    setOpen(false);
    setEmail(""); setRole("provider");
    setCreated(null); setCopied(false);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.adminAddProvider(email.trim(), role);
      // Reveal the temp password in the dialog instead of a transient toast.
      setCreated({ email: res.provider.email, temp_password: res.temp_password });
      setCopied(false);
      load(); // refresh the roster behind the dialog
    } catch {
      toast.error("Could not add provider (email may already exist).");
    } finally { setBusy(false); }
  }

  async function copyPassword() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.temp_password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn’t copy — select the password and copy it manually.");
    }
  }

  async function toggle(p: ProviderRosterItem) {
    try {
      if (p.active) { await api.adminDeactivate(p.id); toast.success(`Deactivated ${p.email}`); }
      else { await api.adminActivate(p.id); toast.success(`Reactivated ${p.email}`); }
      load();
    } catch { toast.error("Action failed."); }
  }

  return (
    <div className="mt-3">
      <div className="mb-3 flex justify-end">
        <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : resetDialog())}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5"><UserPlus className="h-4 w-4" />Add provider</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm">{created ? "Provider created" : "Add provider"}</DialogTitle>
            </DialogHeader>
            {created ? (
              <div className="space-y-3">
                <div className="rounded-md border border-success/40 bg-success/5 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-success">
                    <UserPlus className="h-3.5 w-3.5" />
                    {created.email}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Share this securely. The temporary password is shown only once and can’t be
                    retrieved later — the provider should change it on first sign-in.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Temporary password</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 select-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm tracking-wide">
                      {created.temp_password}
                    </code>
                    <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 gap-1.5" onClick={copyPassword}>
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" onClick={resetDialog}>Done</Button>
                </DialogFooter>
              </div>
            ) : (
              <form onSubmit={add} className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Email</Label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Role</Label>
                  <Select value={role} onValueChange={(v) => setRole(v as "provider" | "admin")}>
                    <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="provider" className="text-xs">Provider</SelectItem>
                      <SelectItem value="admin" className="text-xs">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">A temporary password is generated and shown once.</p>
                <DialogFooter>
                  <Button type="submit" disabled={busy} className="gap-1.5">
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Create
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead><TableHead>Role</TableHead>
              <TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></TableCell></TableRow>
            )}
            {rows?.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">{p.email}</TableCell>
                <TableCell><Badge variant="outline" className="text-[10px] uppercase">{p.role}</Badge></TableCell>
                <TableCell>
                  <Badge variant="outline" className={p.active ? "border-success/40 text-success" : "border-destructive/40 text-destructive"}>
                    {p.active ? "active" : "inactive"}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmt(p.created_at)}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => toggle(p)}>
                    {p.active ? <><UserMinus className="h-3.5 w-3.5" />Deactivate</> : <><UserPlus className="h-3.5 w-3.5" />Reactivate</>}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// --- Templates -------------------------------------------------------------
const BLANK_T = { id: 0, name: "", encounter_type: "", system_prompt: "" };
function TemplatesTab() {
  const [rows, setRows] = useState<TemplateOut[] | null>(null);
  const [editing, setEditing] = useState<typeof BLANK_T | null>(null);
  const [busy, setBusy] = useState(false);

  function load() { api.adminTemplates().then(setRows); }
  useEffect(load, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      if (editing.id === 0) {
        await api.adminCreateTemplate(editing.name, editing.encounter_type, editing.system_prompt);
        toast.success("Template created.");
      } else {
        await api.adminUpdateTemplate(editing.id, {
          name: editing.name, encounter_type: editing.encounter_type, system_prompt: editing.system_prompt,
        });
        toast.success("Template updated — effective on the next generation.");
      }
      setEditing(null); load();
    } catch { toast.error("Save failed."); } finally { setBusy(false); }
  }

  async function archive(t: TemplateOut) {
    try { await api.adminArchiveTemplate(t.id); toast.success(`Archived ${t.name}`); load(); }
    catch { toast.error("Archive failed."); }
  }

  return (
    <div className="mt-3">
      <div className="mb-3 flex justify-end">
        <Button size="sm" className="gap-1.5" onClick={() => setEditing({ ...BLANK_T })}>
          <Plus className="h-4 w-4" />New template
        </Button>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Type</TableHead>
              <TableHead>Status</TableHead><TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null && (
              <TableRow><TableCell colSpan={4} className="py-8 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></TableCell></TableRow>
            )}
            {rows?.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{t.encounter_type}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={t.status === "active" ? "border-success/40 text-success" : "border-muted-foreground/40 text-muted-foreground"}>
                    {t.status}
                  </Badge>
                </TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing({ id: t.id, name: t.name, encounter_type: t.encounter_type, system_prompt: t.system_prompt })}>Edit</Button>
                  {t.status === "active" && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => archive(t)}>Archive</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle className="text-sm">{editing?.id ? "Edit template" : "New template"}</DialogTitle></DialogHeader>
          {editing && (
            <form onSubmit={save} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Name</Label>
                  <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Encounter type</Label>
                  <Input value={editing.encounter_type} onChange={(e) => setEditing({ ...editing, encounter_type: e.target.value })} required />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">System prompt</Label>
                <Textarea
                  value={editing.system_prompt}
                  onChange={(e) => setEditing({ ...editing, system_prompt: e.target.value })}
                  className="min-h-[160px] text-xs leading-relaxed"
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  Shapes how the AI writes SOAP notes for this encounter type. Edits take effect on providers’ next generation.
                </p>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={busy} className="gap-1.5">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
