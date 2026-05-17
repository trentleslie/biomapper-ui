import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useListJobs, useUpdateJob, useDeleteJob, getListJobsQueryKey } from "@workspace/api-client-react";
import { deleteOriginalData } from "@/lib/original-data-store";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pencil, Trash2, FileQuestion } from "lucide-react";

function relativeTime(epochSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - epochSeconds);

  if (diff < 60) return "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} minute${m !== 1 ? "s" : ""} ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h !== 1 ? "s" : ""} ago`;
  }
  if (diff < 2592000) {
    const d = Math.floor(diff / 86400);
    return `${d} day${d !== 1 ? "s" : ""} ago`;
  }
  if (diff < 31536000) {
    const mo = Math.floor(diff / 2592000);
    return `${mo} month${mo !== 1 ? "s" : ""} ago`;
  }
  const y = Math.floor(diff / 31536000);
  return `${y} year${y !== 1 ? "s" : ""} ago`;
}

function statusBadge(status: string) {
  switch (status) {
    case "complete":
      return <Badge variant="success">Complete</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export default function JobsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: jobs, isLoading } = useListJobs({ query: { retry: 1 } });
  const updateMutation = useUpdateJob();
  const deleteMutation = useDeleteJob();

  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const [deleteTarget, setDeleteTarget] = useState<{ jobId: string; name: string } | null>(null);

  useEffect(() => {
    if (editingJobId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingJobId]);

  const startEditing = (jobId: string, currentName: string) => {
    setEditingJobId(jobId);
    setEditValue(currentName);
  };

  const cancelEditing = () => {
    setEditingJobId(null);
    setEditValue("");
  };

  const saveEdit = (jobId: string) => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      cancelEditing();
      return;
    }
    updateMutation.mutate(
      { jobId, data: { displayName: trimmed } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
          cancelEditing();
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Rename failed",
            description: "Could not update the job name. Please try again.",
          });
          cancelEditing();
        },
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const { jobId } = deleteTarget;
    deleteMutation.mutate(
      { jobId },
      {
        onSuccess: () => {
          deleteOriginalData(jobId).catch(() => {});
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
          setDeleteTarget(null);
          // If user is somehow viewing this job, redirect
          if (window.location.pathname.includes(`/job/${jobId}`)) {
            setLocation("/");
          }
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Delete failed",
            description: "Could not delete the job. Please try again.",
          });
          setDeleteTarget(null);
        },
      },
    );
  };

  const jobList = jobs || [];

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">Job History</h1>
        <p className="text-sm text-neutral-500 mt-1">View and manage all your mapping jobs.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Jobs</CardTitle>
          <CardDescription>
            {isLoading
              ? "Loading..."
              : `${jobList.length} job${jobList.length !== 1 ? "s" : ""}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobList.length === 0 && !isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12">
                    <div className="flex flex-col items-center gap-2 text-neutral-400">
                      <FileQuestion className="w-8 h-8" />
                      <p>No jobs yet. Start by uploading a file.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                jobList.map((job) => {
                  const displayName = job.displayName || `${job.jobId.slice(0, 8)}...`;
                  const isEditing = editingJobId === job.jobId;

                  return (
                    <TableRow
                      key={job.jobId}
                      className="cursor-pointer hover:bg-neutral-50"
                      onClick={() => setLocation(`/job/${job.jobId}`)}
                    >
                      <TableCell className="font-medium max-w-[250px]">
                        {isEditing ? (
                          <div
                            className="flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Input
                              ref={editInputRef}
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEdit(job.jobId);
                                if (e.key === "Escape") cancelEditing();
                              }}
                              className="h-7 text-sm"
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 group">
                            <span className="truncate">{displayName}</span>
                            <button
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-neutral-200"
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditing(job.jobId, job.displayName || "");
                              }}
                              title="Rename"
                            >
                              <Pencil className="w-3.5 h-3.5 text-neutral-400" />
                            </button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{statusBadge(job.status)}</TableCell>
                      <TableCell className="tabular-nums">{job.total}</TableCell>
                      <TableCell className="text-neutral-500 text-sm">
                        {relativeTime(job.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-neutral-400 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget({ jobId: job.jobId, name: displayName });
                          }}
                          title="Delete job"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete job?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deleteTarget?.name}&rdquo; will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete job
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
