import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { cn } from "@/lib/utils";

export function FeedbackButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="default"
        size="icon"
        aria-label="Submit feedback"
        className={cn(
          "fixed bottom-6 right-6 z-50 rounded-full opacity-70 transition-all duration-200 hover:opacity-100 hover:scale-110",
          open && "opacity-0 pointer-events-none",
        )}
        onClick={() => setOpen(true)}
      >
        <MessageSquarePlus />
      </Button>

      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
