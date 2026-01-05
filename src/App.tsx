import { useState, useEffect } from "react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { SettingsPage } from "@/components/SettingsPage";

function getRoute(): "player" | "settings" {
  if (typeof window === "undefined") return "player";
  return window.location.pathname === "/settings" ? "settings" : "player";
}

function App() {
  const [route, setRoute] = useState<"player" | "settings">(getRoute);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(getRoute());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  if (route === "settings") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <SettingsPage />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h1 className="text-2xl font-bold mb-8">Audio Player</h1>
      <AudioPlayer />
    </div>
  );
}

export default App;
