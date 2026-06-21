import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FilePlus2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/api/client";
import type { EncounterListItem } from "@/api/types";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

function fmt(ts: string) {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function EncounterList() {
  const navigate = useNavigate();
  const { handleAuthError } = useAuth();
  const [rows, setRows] = useState<EncounterListItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [dob, setDob] = useState("");
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<EncounterListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api.listEncounters().then(setRows).catch((e) => {
      handleAuthError(e);
      setRows([]);
    });
  }, [handleAuthError]);

  async function createEncounter(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const enc = await api.createEncounter(first.trim(), last.trim(), dob);
      navigate(`/encounters/${enc.id}/intake`);
    } catch (err) {
      if (err instanceof ApiError) handleAuthError(err);
      toast.error("Could not start encounter.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.deleteEncounter(toDelete.id);
      setRows((prev) => (prev ? prev.filter((x) => x.id !== toDelete.id) : prev));
      toast.success("Encounter permanently deleted.");
      setToDelete(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // The encounter is already gone (stale list row) — drop it quietly
        // rather than surfacing an error.
        setRows((prev) => (prev ? prev.filter((x) => x.id !== toDelete.id) : prev));
        toast.message("That encounter was already removed.");
        setToDelete(null);
      } else {
        if (err instanceof ApiError) handleAuthError(err);
        toast.error("Could not delete encounter.");
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">My encounters</h1>
          <p className="text-xs text-muted-foreground">
            Your drafts and finalized notes.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5">
              <FilePlus2 className="h-4 w-4" />
              New encounter
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm">New encounter</DialogTitle>
            </DialogHeader>
            <form onSubmit={createEncounter} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="first" className="text-xs">First name</Label>
                  <Input id="first" value={first} onChange={(e) => setFirst(e.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="last" className="text-xs">Last name</Label>
                  <Input id="last" value={last} onChange={(e) => setLast(e.target.value)} required />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dob" className="text-xs">Date of birth</Label>
                <Input id="dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} required />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={busy} className="gap-1.5">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Continue
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Patient</TableHead>
              <TableHead>DOB</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last updated</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            )}
            {rows?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  No encounters yet. Start one with “New encounter”.
                </TableCell>
              </TableRow>
            )}
            {rows?.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() =>
                  navigate(
                    // A fresh draft (no generated note yet) resumes at intake;
                    // anything with content opens directly in the workspace.
                    r.status === "draft" && !r.has_working_note
                      ? `/encounters/${r.id}/intake`
                      : `/encounters/${r.id}`,
                  )
                }
              >
                <TableCell className="font-medium">{r.patient_name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{r.patient_dob}</TableCell>
                <TableCell>
                  {r.status === "draft" ? (
                    <Badge variant="outline" className="border-warning/40 text-warning">
                      Draft
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-success/40 text-success">
                      Finalized
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmt(r.updated_at)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Delete encounter"
                    className="h-7 w-7 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setToDelete(r); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={toDelete !== null} onOpenChange={(o) => { if (!o) setToDelete(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm text-destructive">Delete encounter permanently?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will <span className="font-medium text-foreground">permanently delete</span>
            {toDelete ? ` ${toDelete.patient_name}'s` : " this"} encounter, including its transcript and
            every saved note version. This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setToDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" className="gap-1.5" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
