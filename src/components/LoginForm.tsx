import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";

export function LoginForm() {
  const { login } = useAuth();
  const [npubInput, setNpubInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    setError(null);
    setIsLoading(true);

    const npub = npubInput.trim();
    const secret = secretInput.trim();

    if (!npub) {
      setError("Please enter your npub");
      setIsLoading(false);
      return;
    }

    if (!npub.startsWith("npub1")) {
      setError("Invalid npub format. Must start with 'npub1'");
      setIsLoading(false);
      return;
    }

    if (!secret) {
      setError("Please enter your secondary secret");
      setIsLoading(false);
      return;
    }

    try {
      const result = await login(npub, secret);
      if (!result.success) {
        setError(result.error ?? "Login failed");
      }
      // Success - auth context will update and trigger re-render
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && npubInput.trim() && secretInput.trim()) {
      handleLogin();
    }
  };

  return (
    <div className="w-full max-w-sm mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-xl font-semibold">Welcome</h2>
        <p className="text-sm text-muted-foreground">
          Enter your credentials to sync your playback history across devices.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="npub" className="text-sm font-medium">
            npub (public key)
          </label>
          <Input
            id="npub"
            type="text"
            value={npubInput}
            onChange={(e) => setNpubInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="npub1..."
            className="h-9 text-sm font-mono"
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="secret" className="text-sm font-medium">
            Secondary Secret
          </label>
          <Input
            id="secret"
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter your secondary secret"
            className="h-9 text-sm font-mono"
            disabled={isLoading}
          />
        </div>

        {error && (
          <div className="text-sm p-2 rounded bg-red-500/10 text-red-600 border border-red-500/20">
            {error}
          </div>
        )}

        <Button
          onClick={handleLogin}
          disabled={isLoading || !npubInput.trim() || !secretInput.trim()}
          className="w-full h-9"
        >
          {isLoading ? "Logging in..." : "Login"}
        </Button>
      </div>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Or</span>
        </div>
      </div>

      <div className="text-center space-y-2">
        <Link to="/rotate">
          <Button variant="outline" className="w-full h-9">
            Rotate Credentials
          </Button>
        </Link>
        <p className="text-xs text-muted-foreground">
          Sync issues, compromised credentials, or need a fresh start?
        </p>
      </div>
    </div>
  );
}
