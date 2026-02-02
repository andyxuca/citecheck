"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, XCircle, AlertCircle, ExternalLink } from "lucide-react"

export interface Citation {
  id: string
  title?: string
  authors?: string[]
  text: string
  status: "verified" | "unverified"
  score?: number
  source_url?: string
  details?: string
}

export interface VerificationResult {
  id: string
  paper_title: string
  total_citations: number
  verified_count: number
  unverified_count: number
  citations: Citation[]
  created_at: string
}

interface VerificationResultsProps {
  result: VerificationResult
}

export function VerificationResults({ result }: VerificationResultsProps) {
  const getStatusIcon = (status: Citation["status"]) => {
    switch (status) {
      case "verified":
        return <CheckCircle2 className="h-5 w-5 text-accent" />
      case "unverified":
        return <XCircle className="h-5 w-5 text-destructive" />
    }
  }

  const getStatusBadge = (status: Citation["status"]) => {
    switch (status) {
      case "verified":
        return <Badge className="bg-accent/10 text-accent hover:bg-accent/20">Verified</Badge>
      case "unverified":
        return <Badge variant="destructive">Unverified</Badge>
    }
  }

  const verificationRate = Math.round((result.verified_count / result.total_citations) * 100)

  return (
    <div className="space-y-6">
      {/* Summary Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{result.paper_title}</CardTitle>
          <CardDescription>
            Verified on {new Date(result.created_at).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg bg-secondary p-4 text-center">
              <p className="text-3xl font-bold text-foreground">{result.total_citations}</p>
              <p className="text-sm text-muted-foreground">Total Citations</p>
            </div>
            <div className="rounded-lg bg-accent/10 p-4 text-center">
              <p className="text-3xl font-bold text-accent">{result.verified_count}</p>
              <p className="text-sm text-muted-foreground">Verified</p>
            </div>
            <div className="rounded-lg bg-destructive/10 p-4 text-center">
              <p className="text-3xl font-bold text-destructive">{result.total_citations - result.verified_count}</p>
              <p className="text-sm text-muted-foreground">Unverified</p>
            </div>
          </div>
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Verification Rate</span>
              <span className="font-medium text-foreground">{verificationRate}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${verificationRate}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Citations List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Citation Details</CardTitle>
          <CardDescription>
            Review each citation and its verification status
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {result.citations.map((citation, index) => (
            <div
              key={citation.id}
              className="flex items-start gap-4 rounded-lg border border-border p-4"
            >
              <div className="mt-0.5">{getStatusIcon(citation.status)}</div>
              <div className="flex-1 space-y-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-foreground">
                      <span className="text-muted-foreground">[{index + 1}]</span>{" "}
                      {citation.title || citation.text}
                    </p>
                    {citation.authors && citation.authors.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {citation.authors.join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {citation.score !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        {Math.round(citation.score * 100)}%
                      </span>
                    )}
                    {getStatusBadge(citation.status)}
                  </div>
                </div>
                {citation.details && (
                  <p className="text-sm text-muted-foreground">{citation.details}</p>
                )}
                {citation.source_url && (
                  <a
                    href={citation.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    View Source <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
