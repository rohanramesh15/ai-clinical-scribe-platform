import { Link, useNavigate } from "react-router-dom";
import { Activity, LogOut } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Persistent top bar on every authenticated screen. Logout is a global action,
// never the tail of a flow.
export function TopBar() {
  const { provider, logout } = useAuth();
  const navigate = useNavigate();
  const home = provider?.role === "admin" ? "/admin" : "/";

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-border bg-card px-4">
      <Link to={home} className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold tracking-tight">Clinical Scribe</span>
        {provider?.role === "admin" && (
          <Badge variant="outline" className="ml-1 border-primary/30 text-primary">
            Admin
          </Badge>
        )}
      </Link>
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground">{provider?.email}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground"
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
        >
          <LogOut className="h-3.5 w-3.5" />
          Log out
        </Button>
      </div>
    </header>
  );
}
