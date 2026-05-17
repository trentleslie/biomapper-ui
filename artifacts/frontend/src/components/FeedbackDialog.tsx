import { useState, useEffect } from "react";
import { useUser } from "@clerk/react";
import { customFetch } from "@workspace/api-client-react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type Category = "annotation_issue" | "feature_request" | "ui_error";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "annotation_issue", label: "Annotation Issue" },
  { value: "feature_request", label: "Feature Request" },
  { value: "ui_error", label: "UI Error" },
];

const MIN_DESC = 10;
const MAX_DESC = 5000;

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function extractJobId(): string | null {
  const match = window.location.pathname.match(/\/job\/([^/]+)/);
  return match ? match[1] : null;
}

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const { user } = useUser();
  const { toast } = useToast();

  const [category, setCategory] = useState<Category>("feature_request");
  const [description, setDescription] = useState("");
  const [expectedResult, setExpectedResult] = useState("");
  const [stepsToReproduce, setStepsToReproduce] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [contextExpanded, setContextExpanded] = useState(false);

  // Auto-captured context
  const [pageUrl, setPageUrl] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);

  // Capture context when dialog opens
  useEffect(() => {
    if (open) {
      setPageUrl(window.location.href);
      setJobId(extractJobId());
    }
  }, [open]);

  function resetForm() {
    setCategory("feature_request");
    setDescription("");
    setExpectedResult("");
    setStepsToReproduce("");
    setValidationError("");
    setContextExpanded(false);
  }

  function handleCategoryChange(newCategory: Category) {
    setCategory(newCategory);
    // Description persists, category-specific fields reset
    setExpectedResult("");
    setStepsToReproduce("");
    setValidationError("");
  }

  async function handleSubmit() {
    if (description.length < MIN_DESC) {
      setValidationError(`Description must be at least ${MIN_DESC} characters`);
      return;
    }
    setValidationError("");
    setSubmitting(true);

    const payload = {
      category,
      description,
      metadata: {
        pageUrl,
        jobId,
        userAgent: navigator.userAgent,
        expectedResult: category === "annotation_issue" ? expectedResult || null : null,
        stepsToReproduce: category === "ui_error" ? stepsToReproduce || null : null,
      },
      userEmail: user?.primaryEmailAddress?.emailAddress || "unknown",
    };

    try {
      await customFetch("/feedback", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });
      toast({ title: "Feedback submitted — thank you!" });
      resetForm();
      onOpenChange(false);
    } catch {
      toast({
        title: "Unable to submit feedback",
        description: "Please try again later.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-y-auto max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Submit Feedback</DialogTitle>
          <DialogDescription>
            Report an issue, request a feature, or flag a bug.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Category selector — RadioGroup-style */}
          <fieldset>
            <legend className="text-sm font-medium text-neutral-700 mb-2">
              Category
            </legend>
            <div
              className="flex gap-1 rounded-lg bg-neutral-100 p-1"
              role="radiogroup"
              aria-label="Feedback category"
            >
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  role="radio"
                  aria-checked={category === cat.value}
                  className={`flex-1 text-sm py-1.5 px-2 rounded-md transition-colors ${
                    category === cat.value
                      ? "bg-white text-neutral-900 font-medium shadow-sm"
                      : "text-neutral-500 hover:text-neutral-700"
                  }`}
                  onClick={() => handleCategoryChange(cat.value)}
                  onKeyDown={(e) => {
                    const idx = CATEGORIES.findIndex((c) => c.value === cat.value);
                    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                      e.preventDefault();
                      const next = CATEGORIES[(idx + 1) % CATEGORIES.length];
                      handleCategoryChange(next.value);
                    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const prev = CATEGORIES[(idx - 1 + CATEGORIES.length) % CATEGORIES.length];
                      handleCategoryChange(prev.value);
                    }
                  }}
                  tabIndex={category === cat.value ? 0 : -1}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Description */}
          <div>
            <label
              htmlFor="feedback-description"
              className="text-sm font-medium text-neutral-700"
            >
              Description <span className="text-red-500">*</span>
            </label>
            <textarea
              id="feedback-description"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-400 focus:ring-offset-1 min-h-[100px] resize-y"
              placeholder={
                category === "annotation_issue"
                  ? "Describe the mapping issue you found..."
                  : category === "ui_error"
                    ? "Describe what went wrong..."
                    : "Describe the feature you'd like..."
              }
              value={description}
              onChange={(e) => {
                setDescription(e.target.value.slice(0, MAX_DESC));
                if (validationError) setValidationError("");
              }}
              maxLength={MAX_DESC}
            />
            <div className="flex justify-between mt-1">
              {validationError ? (
                <span className="text-xs text-red-500">{validationError}</span>
              ) : (
                <span />
              )}
              <span className="text-xs text-neutral-400">
                {description.length} / {MAX_DESC}
              </span>
            </div>
          </div>

          {/* Category-specific fields */}
          {category === "annotation_issue" && (
            <>
              <div>
                <label
                  htmlFor="expected-result"
                  className="text-sm font-medium text-neutral-700"
                >
                  Expected result{" "}
                  <span className="text-neutral-400 font-normal">(optional)</span>
                </label>
                <textarea
                  id="expected-result"
                  className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-400 focus:ring-offset-1 min-h-[60px] resize-y"
                  placeholder="What should the correct mapping be?"
                  value={expectedResult}
                  onChange={(e) => setExpectedResult(e.target.value)}
                />
              </div>

              {/* Captured context disclosure */}
              <div>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700"
                  onClick={() => setContextExpanded(!contextExpanded)}
                >
                  {contextExpanded ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  Captured context
                </button>
                {contextExpanded && (
                  <div className="mt-1 text-xs text-neutral-500 bg-neutral-50 rounded px-3 py-2 space-y-0.5">
                    <div>Page: {pageUrl}</div>
                    {jobId && <div>Job ID: {jobId}</div>}
                  </div>
                )}
              </div>
            </>
          )}

          {category === "ui_error" && (
            <div>
              <label
                htmlFor="steps-to-reproduce"
                className="text-sm font-medium text-neutral-700"
              >
                Steps to reproduce{" "}
                <span className="text-neutral-400 font-normal">(optional)</span>
              </label>
              <textarea
                id="steps-to-reproduce"
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-400 focus:ring-offset-1 min-h-[60px] resize-y"
                placeholder="1. Go to... 2. Click on... 3. See error..."
                value={stepsToReproduce}
                onChange={(e) => setStepsToReproduce(e.target.value)}
              />
            </div>
          )}

          {/* Submit */}
          <Button
            className="w-full"
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Submitting..." : "Submit feedback"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
