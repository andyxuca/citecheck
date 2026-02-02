"use client"

import { useState } from "react"
import { PdfUpload } from "@/components/pdf-upload"
import { VerificationResults, type VerificationResult } from "@/components/verification-results"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FileText, Shield, Clock } from "lucide-react"

export default function DashboardPage() {
  const [isUploading, setIsUploading] = useState(false)
  const [result, setResult] = useState<VerificationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleUpload = async (file: File) => {
    setIsUploading(true)
    setError(null)
    setResult(null)

    try {
      const formData = new FormData()
      formData.append("file", file)

      const response = await fetch("/api/verify", {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        const text = await response.text()
        let errorMessage = "Failed to verify citations"
        try {
          const data = JSON.parse(text)
          errorMessage = data.error || errorMessage
        } catch {
          errorMessage = text || errorMessage
        }
        throw new Error(errorMessage)
      }

      const data = await response.json()
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Upload Paper</h1>
        <p className="mt-2 text-muted-foreground">
          Upload your research paper PDF to verify its citations
        </p>
      </div>

      <PdfUpload onUpload={handleUpload} isUploading={isUploading} />

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {result && <VerificationResults result={result} />}

      {!result && !isUploading && (
        <div className="grid gap-6 md:grid-cols-3">
          <Card>
            <CardHeader>
              <FileText className="h-8 w-8 text-primary" />
              <CardTitle className="text-foreground">PDF Support</CardTitle>
              <CardDescription>
                Upload any research paper in PDF format for analysis
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Shield className="h-8 w-8 text-accent" />
              <CardTitle className="text-foreground">AI Verification</CardTitle>
              <CardDescription>
                Our AI searches academic databases to verify each citation
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Clock className="h-8 w-8 text-primary" />
              <CardTitle className="text-foreground">Quick Results</CardTitle>
              <CardDescription>
                Get detailed verification results in minutes, not hours
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )}
    </div>
  )
}
