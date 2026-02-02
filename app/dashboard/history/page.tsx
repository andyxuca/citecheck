"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { FileText, ChevronRight, Loader2, History } from "lucide-react"
import Link from "next/link"

interface PaperSummary {
  id: string
  title: string
  file_name: string
  status: string
  total_citations: number
  verified_citations: number
  unverified_citations: number
  created_at: string
}

export default function HistoryPage() {
  const [papers, setPapers] = useState<PaperSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchPapers = async () => {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("papers")
        .select("id, title, file_name, status, total_citations, verified_citations, unverified_citations, created_at")
        .order("created_at", { ascending: false })

      if (!error && data) {
        setPapers(data)
      }
      setIsLoading(false)
    }

    fetchPapers()
  }, [])

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-accent/10 text-accent">Completed</Badge>
      case "processing":
        return <Badge variant="secondary">Processing</Badge>
      case "failed":
        return <Badge variant="destructive">Failed</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Verification History</h1>
        <p className="mt-2 text-muted-foreground">
          View all your past citation verification results
        </p>
      </div>

      {papers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <History className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 font-semibold text-foreground">No papers yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload your first research paper to get started
            </p>
            <Link href="/dashboard" className="mt-4">
              <Button>Upload Paper</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {papers.map((paper) => {
            const verificationRate = paper.total_citations > 0
              ? Math.round((paper.verified_citations / paper.total_citations) * 100)
              : 0

            return (
              <Card key={paper.id} className="transition-colors hover:bg-muted/50">
                <CardContent className="py-4">
                  <Link href={`/dashboard/paper/${paper.id}`}>
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <FileText className="h-6 w-6 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <h3 className="font-semibold text-foreground truncate">
                              {paper.title || paper.file_name}
                            </h3>
                            <p className="text-sm text-muted-foreground">
                              {new Date(paper.created_at).toLocaleDateString()} at{" "}
                              {new Date(paper.created_at).toLocaleTimeString()}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {getStatusBadge(paper.status)}
                            <ChevronRight className="h-5 w-5 text-muted-foreground" />
                          </div>
                        </div>
                        {paper.status === "completed" && (
                          <div className="mt-3 flex items-center gap-4">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-accent">
                                {paper.verified_citations} verified
                              </span>
                              <span className="text-sm text-muted-foreground">/</span>
                              <span className="text-sm font-medium text-destructive">
                                {paper.total_citations - paper.verified_citations} unverified
                              </span>
                              <span className="text-sm text-muted-foreground">
                                of {paper.total_citations} total
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-24 overflow-hidden rounded-full bg-secondary">
                                <div
                                  className="h-full bg-accent transition-all"
                                  style={{ width: `${verificationRate}%` }}
                                />
                              </div>
                              <span className="text-sm font-medium text-foreground">
                                {verificationRate}%
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
