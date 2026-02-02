import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FileText, Shield, History, ArrowRight, CheckCircle2, Search, BookOpen } from "lucide-react"

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
              <BookOpen className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-xl font-semibold text-foreground">CiteCheck</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/auth/login">
              <Button variant="ghost" className="text-muted-foreground hover:text-foreground">
                Login
              </Button>
            </Link>
            <Link href="/auth/sign-up">
              <Button>Get Started</Button>
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Verify Your Research Paper Citations with Confidence
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            Upload your research papers and let our AI-powered system verify that every citation exists 
            and is accurately referenced. Ensure academic integrity before submission.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link href="/auth/sign-up">
              <Button size="lg" className="gap-2 px-8">
                Start Verifying <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link href="/auth/login">
              <Button size="lg" variant="outline" className="px-8 bg-transparent">
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="border-t border-border bg-card px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-foreground">How It Works</h2>
            <p className="mt-3 text-muted-foreground">
              Three simple steps to verify your citations
            </p>
          </div>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            <Card className="border-border bg-background">
              <CardHeader>
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <FileText className="h-6 w-6 text-primary" />
                </div>
                <CardTitle className="mt-4 text-foreground">Upload Your PDF</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Simply drag and drop your research paper PDF or browse to upload
                </CardDescription>
              </CardHeader>
            </Card>
            <Card className="border-border bg-background">
              <CardHeader>
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent/10">
                  <Search className="h-6 w-6 text-accent" />
                </div>
                <CardTitle className="mt-4 text-foreground">AI Analysis</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Our system extracts citations and verifies each one exists in academic databases
                </CardDescription>
              </CardHeader>
            </Card>
            <Card className="border-border bg-background">
              <CardHeader>
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <CheckCircle2 className="h-6 w-6 text-primary" />
                </div>
                <CardTitle className="mt-4 text-foreground">Get Results</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Receive a detailed report showing verified and unverified citations
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold text-foreground">
                Why Verify Your Citations?
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
                Citation errors can undermine the credibility of your research. 
                CiteCheck helps you maintain academic integrity and avoid common pitfalls.
              </p>
              <ul className="mt-8 space-y-4">
                {[
                  "Detect fabricated or non-existent references",
                  "Identify broken links and outdated sources",
                  "Ensure proper attribution of ideas",
                  "Save time on manual verification",
                ].map((benefit, index) => (
                  <li key={index} className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                    <span className="text-foreground">{benefit}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card className="border-border">
                <CardContent className="pt-6">
                  <Shield className="h-8 w-8 text-primary" />
                  <h3 className="mt-4 font-semibold text-foreground">Academic Integrity</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Ensure your research meets the highest standards of scholarly work
                  </p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="pt-6">
                  <History className="h-8 w-8 text-accent" />
                  <h3 className="mt-4 font-semibold text-foreground">Full History</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Access all your past verifications and track improvements
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="border-t border-border bg-card px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold text-foreground">
            Ready to Verify Your Citations?
          </h2>
          <p className="mt-4 text-muted-foreground">
            Join researchers and academics who trust CiteCheck for citation verification.
          </p>
          <Link href="/auth/sign-up">
            <Button size="lg" className="mt-8 gap-2 px-8">
              Create Free Account <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-primary">
              <BookOpen className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-medium text-foreground">CiteCheck</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Research citation verification
          </p>
        </div>
      </footer>
    </div>
  )
}
