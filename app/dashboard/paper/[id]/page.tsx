import { createClient } from "@/lib/supabase/server"
import { notFound } from "next/navigation"
import { VerificationResults, type Citation, type VerificationResult } from "@/components/verification-results"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function PaperDetailPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()

  const { data: paper, error: paperError } = await supabase
    .from("papers")
    .select("*")
    .eq("id", id)
    .single()

  if (paperError || !paper) {
    notFound()
  }

  const { data: citations, error: citationsError } = await supabase
    .from("citations")
    .select("*")
    .eq("paper_id", id)
    .order("created_at", { ascending: true })

  if (citationsError) {
    notFound()
  }

  const formattedCitations: Citation[] = (citations || []).map((c) => ({
    id: c.id,
    title: c.title,
    authors: c.authors ? c.authors.split(", ") : [],
    text: c.citation_text,
    status: c.verification_status as Citation["status"],
    score: c.score,
    source_url: c.source_url,
    details: c.verification_details,
  }))

  const verifiedCount = formattedCitations.filter((c) => c.status === "verified").length
  const notFoundCount = formattedCitations.filter((c) => c.status === "not_found").length
  const uncertainCount = formattedCitations.filter((c) => c.status === "uncertain").length

  const result: VerificationResult = {
    id: paper.id,
    paper_title: paper.title || paper.file_name,
    total_citations: formattedCitations.length,
    verified_count: verifiedCount,
    not_found_count: notFoundCount,
    uncertain_count: uncertainCount,
    citations: formattedCitations,
    created_at: paper.created_at,
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/history">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Verification Results</h1>
          <p className="text-muted-foreground">
            Detailed citation analysis for your paper
          </p>
        </div>
      </div>

      <VerificationResults result={result} />
    </div>
  )
}
