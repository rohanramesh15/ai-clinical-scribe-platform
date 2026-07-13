import { Link, useNavigate } from "react-router-dom";
import { LogOut, Menu } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Persistent top bar on every authenticated screen. Logout is a global action,
// never the tail of a flow.
export function TopBar() {
  const { provider, logout } = useAuth();
  const navigate = useNavigate();
  const home = provider?.role === "admin" ? "/admin" : "/";

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-border bg-card px-4">
      <Link to={home} className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-tight">Clinical Scribe</span>
        {provider?.role === "admin" && (
          <Badge variant="outline" className="ml-1 border-primary/30 text-primary">
            Admin
          </Badge>
        )}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 px-0 text-muted-foreground"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel
            title={provider?.email}
            className="truncate font-mono text-xs font-normal text-muted-foreground"
          >
            {provider?.email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-1.5"
            onSelect={async () => {
              await logout();
              navigate("/login");
            }}
          >
            <LogOut className="h-3.5 w-3.5" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
