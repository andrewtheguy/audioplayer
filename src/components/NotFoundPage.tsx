import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <div className="w-full max-w-sm mx-auto text-center space-y-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">Page not found</p>
      <Link to="/">
        <Button variant="outline">Go Home</Button>
      </Link>
    </div>
  );
}
