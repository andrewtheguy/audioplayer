import { Routes, Route } from "react-router";
import { AudioPlayer } from "@/components/AudioPlayer";
import { SettingsPage } from "@/components/SettingsPage";

function PlayerPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h1 className="text-2xl font-bold mb-8">Audio Player</h1>
      <AudioPlayer />
    </div>
  );
}

function SettingsRoute() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <SettingsPage />
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<PlayerPage />} />
      <Route path="/settings" element={<SettingsRoute />} />
      <Route path="/:npub" element={<PlayerPage />} />
    </Routes>
  );
}

export default App;
