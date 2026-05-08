import { useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

export default function AccessDeniedPage() {
  const { signOut } = useClerk();

  return (
    <div className="min-h-screen bg-neutral-0 flex flex-col items-center justify-center p-6 text-center">
      <div className="w-16 h-16 rounded-full bg-danger-bg text-danger flex items-center justify-center mb-6">
        <ShieldAlert className="w-8 h-8" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight mb-2">Access Denied</h1>
      <p className="text-neutral-500 max-w-md mb-8">
        This application is restricted to PhenomeHealth researchers. Your email domain is not authorized.
      </p>
      <Button variant="default" onClick={() => signOut()}>
        Sign Out and Return Home
      </Button>
    </div>
  );
}
