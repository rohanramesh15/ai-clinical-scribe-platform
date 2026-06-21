import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onReauthed: () => void;
}

// Session-expired-on-save recovery: re-authenticate WITHOUT losing the note,
// which stays in the Workspace's component state. On success the pending save
// is retried by the parent.
export function ReauthDialog({ open, onReauthed }: Props) {
  const { provider, login } = useAuth();
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState(provider?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login((email || provider?.email || "").trim(), password);
      setPassword("");
      onReauthed();
    } catch {
      setError("Sign-in failed. Check your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-sm" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ShieldAlert className="h-4 w-4 text-warning" />
            Session expired
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Your session expired. Sign in again to save — your note is preserved.
        </p>
        <form onSubmit={submit} className="space-y-3">
          {!provider && (
            <div className="space-y-1.5">
              <Label htmlFor="re-email" className="text-xs">Email</Label>
              <Input id="re-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="re-pass" className="text-xs">Password</Label>
            <Input
              id="re-pass"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Sign in & save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
