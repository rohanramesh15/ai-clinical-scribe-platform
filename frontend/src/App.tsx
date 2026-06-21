import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { TopBar } from "@/components/TopBar";
import { Toaster } from "@/components/ui/sonner";
import Login from "@/screens/Login";
import EncounterList from "@/screens/EncounterList";
import Intake from "@/screens/Intake";
import Workspace from "@/screens/Workspace";
import AdminDashboard from "@/screens/AdminDashboard";
import AdminEncounterDetail from "@/screens/AdminEncounterDetail";

function FullSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function Protected() {
  const { status } = useAuth();
  if (status === "loading") return <FullSpinner />;
  if (status === "anon") return <Navigate to="/login" replace />;
  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <Outlet />
    </div>
  );
}

function RoleHome() {
  const { provider } = useAuth();
  return provider?.role === "admin" ? <Navigate to="/admin" replace /> : <EncounterList />;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { provider } = useAuth();
  return provider?.role === "admin" ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Protected />}>
          <Route path="/" element={<RoleHome />} />
          <Route path="/encounters/:id/intake" element={<Intake />} />
          <Route path="/encounters/:id" element={<Workspace />} />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminDashboard />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/encounters/:id"
            element={
              <RequireAdmin>
                <AdminEncounterDetail />
              </RequireAdmin>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster position="top-right" />
    </BrowserRouter>
  );
}
