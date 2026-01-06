import { Routes, Route, Navigate } from "react-router";
import { AudioPlayer } from "@/components/AudioPlayer";
import { RotateCredentialsPage } from "@/components/RotateCredentialsPage";
import { LoginForm } from "@/components/LoginForm";
import { NotFoundPage } from "@/components/NotFoundPage";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";

function HomePage() {
  const { isLoggedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h1 className="text-2xl font-bold mb-8">Audio Player</h1>
      {isLoggedIn ? <AudioPlayer /> : <LoginForm />}
    </div>
  );
}

function RotateRoute() {
  const { isLoggedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Redirect to home if logged in
  if (isLoggedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <RotateCredentialsPage />
    </div>
  );
}

function NotFoundRoute() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <NotFoundPage />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/rotate" element={<RotateRoute />} />
        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
