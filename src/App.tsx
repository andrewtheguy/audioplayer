import { useEffect, useState } from "react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { HomePage } from "@/components/HomePage";
import { Button } from "@/components/ui/button";

function getHashSecret(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash;
  return hash.startsWith("#") ? hash.slice(1) : "";
}

function App() {
  const [hasSecret, setHasSecret] = useState(() => getHashSecret().length > 0);

  useEffect(() => {
    const handleHashChange = () => {
      setHasSecret(getHashSecret().length > 0);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const goToHome = () => {
    window.history.pushState(null, "", window.location.pathname);
    setHasSecret(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="flex items-center gap-4 mb-8">
        <h1 className="text-2xl font-bold">Audio Player</h1>
        {hasSecret && (
          <Button variant="outline" size="sm" onClick={goToHome}>
            Home
          </Button>
        )}
      </div>
      {hasSecret ? <AudioPlayer /> : <HomePage />}
    </div>
  );
}

export default App;
