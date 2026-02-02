// app/api/verify/route.ts
import { createClient } from "@/lib/supabase/server"
import { extractText } from "unpdf"
import { z } from "zod"

// Ensure Node runtime (Edge may not support some PDF/libs reliably)
export const runtime = "nodejs"

/* ----------------------------- Schemas ----------------------------- */

const CitationSchema = z.object({
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
})

const ExtractedCitationsSchema = z.object({
  paperTitle: z.string().default(""),
  citations: z.array(CitationSchema).default([]),
})

type Citation = z.infer<typeof CitationSchema>

/* ----------------------------- Regexes ----------------------------- */

const YEAR_RE = /\b(19|20)\d{2}\b/
const HEADING_RE = /^\s*(references|bibliography|works cited)\s*$/i
const STOP_HEADINGS = new Set([
  "appendix",
  "acknowledgments",
  "acknowledgements",
  "supplementary",
  "supplemental",
  "algorithm",
  "proof",
  "proofs",
])
const STOP_LINE_RE = /^(algorithm|figure|table)\s+\d+/i

/* ----------------------------- Helpers ----------------------------- */

// Serverless-safe timeout wrapper
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
) {
  const { timeoutMs = 15000, ...rest } = init
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(t)
  }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Ratcliff/Obershelp similarity (SequenceMatcher-like).
 * Returns 0..1. This is much closer to difflib.SequenceMatcher().ratio()
 * than ad-hoc character matching.
 */
function sequenceMatcherRatio(aRaw: string, bRaw: string): number {
  const a = aRaw ?? ""
  const b = bRaw ?? ""
  if (!a.length && !b.length) return 1
  if (!a.length || !b.length) return 0

  // recursive sum of lengths of longest common contiguous substrings
  const lcsSum = (s1: string, s2: string): number => {
    const match = longestCommonSubstring(s1, s2)
    if (!match) return 0
    const { i, j, len } = match
    const left = lcsSum(s1.slice(0, i), s2.slice(0, j))
    const right = lcsSum(s1.slice(i + len), s2.slice(j + len))
    return len + left + right
  }

  const matches = lcsSum(a, b)
  return (2 * matches) / (a.length + b.length)
}

// O(n*m) LCS (contiguous) search. Fine for typical title lengths.
function longestCommonSubstring(s1: string, s2: string): { i: number; j: number; len: number } | null {
  const n = s1.length
  const m = s2.length
  let bestLen = 0
  let bestI = 0
  let bestJ = 0

  const dp = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    let prev = 0
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j]
      if (s1[i - 1] === s2[j - 1]) {
        dp[j] = prev + 1
        if (dp[j] > bestLen) {
          bestLen = dp[j]
          bestI = i - bestLen
          bestJ = j - bestLen
        }
      } else {
        dp[j] = 0
      }
      prev = tmp
    }
  }

  return bestLen > 0 ? { i: bestI, j: bestJ, len: bestLen } : null
}

function findReferencesSection(text: string): string {
  const lines = text.split(/\r?\n/)
  let startIdx: number | null = null

  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i].trim())) {
      startIdx = i + 1
      break
    }
  }
  if (startIdx === null) return text

  const collected: string[] = []
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    const stripped = line.trim()

    if (!stripped) {
      collected.push("")
      continue
    }

    const heading = stripped.toLowerCase()
    if (STOP_HEADINGS.has(heading)) break
    if (STOP_LINE_RE.test(stripped)) break

    // "short uppercase heading" stop condition, matching Python
    if (stripped.length <= 40 && stripped === stripped.toUpperCase() && !YEAR_RE.test(stripped)) {
      break
    }

    collected.push(line)
  }
  return collected.join("\n")
}

// Simple concurrency limiter (no dependency)
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = nextIndex++
      if (idx >= items.length) break
      results[idx] = await fn(items[idx], idx)
    }
  })

  await Promise.all(workers)
  return results
}

/* ----------------------------- DeepSeek ----------------------------- */

async function callDeepSeekJSON(prompt: string): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY")

  const res = await fetchWithTimeout("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    timeoutMs: 120000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
    }),
  })

  // Read the body ONCE, then parse. Avoid res.json() then res.text() fallback.
  const rawBody = await res.text().catch(() => "")

  if (!rawBody.trim()) {
    throw new Error(`DeepSeek returned an empty response body (status ${res.status}).`)
  }

  let data: any
  try {
    data = JSON.parse(rawBody)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`DeepSeek response not JSON (${msg}). First 500 chars: ${rawBody.slice(0, 500)}`)
  }

  const content: string = data?.choices?.[0]?.message?.content ?? ""

  if (!content.trim()) {
    throw new Error("DeepSeek returned empty message.content (no JSON to parse).")
  }

  return safeParseJSON(content)
}

function safeParseJSON(text: string): unknown {
  const trimmed = (text ?? "").trim()

  // If model still wraps in code fences, strip them.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1].trim() : trimmed

  // Try parse directly; fallback to extracting first {...} block.
  try {
    return JSON.parse(candidate)
  } catch {
    const obj = candidate.match(/\{[\s\S]*\}/)
    if (!obj) throw new Error("Model did not return valid JSON.")
    return JSON.parse(obj[0])
  }
}

/* ---------------------- Semantic Scholar + arXiv ---------------------- */

type SemanticScholarItem = {
  title?: string
  authors?: { name?: string }[]
  paperId?: string
}

async function semanticScholarLookup(title: string): Promise<SemanticScholarItem | null> {
  const query = title?.trim()
  if (!query) return null

  const params = new URLSearchParams({
    query,
    limit: "1",
    fields: "title,authors,paperId",
  })

  try {
    const res = await fetchWithTimeout(
      `https://api.semanticscholar.org/graph/v1/paper/search/match?${params.toString()}`,
      { timeoutMs: 15000, headers: { Accept: "application/json" } }
    )

    if (!res.ok) return null

    const data = await res.json().catch(() => null)
    // Python code expects data.get("data", []) and takes [0]
    const arr = data?.data
    if (!Array.isArray(arr) || arr.length === 0) return null

    return arr[0] as SemanticScholarItem
  } catch {
    // 404 or network error - return null to try arXiv
    return null
  }
}

function extractSemanticScholarFields(item: SemanticScholarItem | null): { title: string | null; authors: string[]; paperId?: string } {
  if (!item) return { title: null, authors: [] }
  const title = typeof item.title === "string" ? item.title : null
  const authors = Array.isArray(item.authors)
    ? item.authors.map(a => a?.name).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : []
  return { title, authors, paperId: item.paperId }
}

type ArxivFields = { title: string | null; authors: string[]; arxivId?: string }

async function arxivLookup(title: string, authors: string[]): Promise<ArxivFields | null> {
  const queryParts: string[] = []
  if (title?.trim()) queryParts.push(`ti:"${title.replace(/"/g, "")}"`)
  if (authors?.[0]) queryParts.push(`au:"${authors[0].replace(/"/g, "")}"`)
  if (queryParts.length === 0) return null

  const params = new URLSearchParams({
    search_query: queryParts.join(" AND "),
    start: "0",
    max_results: "1",
  })

  try {
    const res = await fetchWithTimeout(`https://export.arxiv.org/api/query?${params.toString()}`, {
      timeoutMs: 20000,
      headers: { Accept: "application/atom+xml, text/xml" },
    })
    if (!res.ok) return null

    const xml = await res.text()

    // Minimal parsing (serverless-safe, no heavy XML deps)
    // Entry title: the first <entry><title>... (excluding feed title)
    const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/i)
    if (!entryMatch) return null
    const entry = entryMatch[0]

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i)
    const authorMatches = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    const idMatch = entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/i)

    const parsedTitle = titleMatch?.[1]
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : null

    const parsedAuthors = authorMatches
      .map(m => m[1]?.replace(/\s+/g, " ").trim())
      .filter((x): x is string => !!x)

    return {
      title: parsedTitle,
      authors: parsedAuthors,
      arxivId: idMatch?.[1],
    }
  } catch {
    return null
  }
}

/* ----------------------------- Scoring ----------------------------- */

function scoreMatchFields(
  refTitle: string | null,
  refAuthors: string[],
  foundTitle: string | null,
  foundAuthors: string[]
): number {
  let titleScore = 0
  if (refTitle && foundTitle) {
    titleScore = sequenceMatcherRatio(normalize(refTitle), normalize(foundTitle))
  }

  let authorScore = 0
  if (refAuthors.length && foundAuthors.length) {
    const refSet = new Set(refAuthors.map(normalize).filter(Boolean))
    const foundSet = new Set(foundAuthors.map(normalize).filter(Boolean))

    if (refSet.size) {
      // Python uses exact set intersection; we'll keep it exact for fidelity.
      let inter = 0
      for (const a of refSet) if (foundSet.has(a)) inter++
      authorScore = inter / refSet.size
    }
  }

  return titleScore * 0.7 + authorScore * 0.3
}

async function verifyCitation(c: Citation, minScore: number) {
  const ssItem = await semanticScholarLookup(c.title)
  const ss = extractSemanticScholarFields(ssItem)
  const ssScore = ssItem ? scoreMatchFields(c.title, c.authors, ss.title, ss.authors) : 0

  const arxiv = await arxivLookup(c.title, c.authors)
  const arxivScore = arxiv ? scoreMatchFields(c.title, c.authors, arxiv.title, arxiv.authors) : 0

  const score = Math.max(ssScore, arxivScore)

  let status: "verified" | "unverified" = score >= minScore ? "verified" : "unverified"
  
  let sourceUrl: string | null = null

  if (status === "verified") {
    if (ssScore >= arxivScore && ss.paperId) sourceUrl = `https://www.semanticscholar.org/paper/${ss.paperId}`
    else if (arxiv?.arxivId) sourceUrl = `https://arxiv.org/abs/${arxiv.arxivId}`
  }

  return {
    ref: c,
    score,
    status,
    semantic_scholar: ssItem
      ? { title: ss.title, authors: ss.authors, score: ssScore }
      : null,
    arxiv: arxiv
      ? { title: arxiv.title, authors: arxiv.authors, score: arxivScore }
      : null,
    sourceUrl,
  }
}

/* ----------------------------- Route ----------------------------- */

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 })

    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const minScoreRaw = formData.get("min_score")
    const minScore = typeof minScoreRaw === "string" ? Number(minScoreRaw) : 0.5

    if (!file || file.type !== "application/pdf") {
      return Response.json({ error: "Please upload a valid PDF file" }, { status: 400 })
    }
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      return Response.json({ error: "min_score must be between 0 and 1" }, { status: 400 })
    }

    // Extract PDF text
    let fullText = ""
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const out = await extractText(bytes, { mergePages: true })
      fullText = Array.isArray(out.text) ? out.text.join("\n") : String(out.text ?? "")
    } catch (e) {
      return Response.json({ error: "Failed to parse PDF file" }, { status: 400 })
    }

    const referencesSection = findReferencesSection(fullText)
    if (!referencesSection.trim()) {
      return Response.json({ error: "Could not find references section in the PDF" }, { status: 400 })
    }

    // DeepSeek extract citations (paperTitle + citations[])
    const prompt =
      `Extract citations from the references section below.\n` +
      `Return strict JSON only: an object with keys ` +
      `"paperTitle" (string) and "citations" (array of { "title": string, "authors": string[] }).\n` +
      `No markdown. No extra keys.\n\n` +
      referencesSection

    const raw = await callDeepSeekJSON(prompt)
    const extracted = ExtractedCitationsSchema.parse(raw)

    if (!extracted.citations.length) {
      return Response.json({ error: "Could not extract citations from the PDF" }, { status: 400 })
    }

    // Create paper record
    const { data: paper, error: paperError } = await supabase
      .from("papers")
      .insert({
        user_id: user.id,
        title: extracted.paperTitle?.trim() || file.name,
        file_name: file.name,
        status: "processing",
        total_citations: extracted.citations.length,
        verified_citations: 0,
      })
      .select()
      .single()

    if (paperError || !paper) {
      return Response.json({ error: "Failed to save paper" }, { status: 500 })
    }

    // Verify citations with limited concurrency to avoid serverless timeouts
    const CONCURRENCY = 4
    const verifications = await mapWithConcurrency(extracted.citations, CONCURRENCY, async (c) => {
      return verifyCitation(c, minScore)
    })

    const verifiedCount = verifications.filter(v => v.status === "verified").length
    const unverifiedCount = verifications.length - verifiedCount

    // Insert citations (batch)
    const rows = verifications.map(v => ({
      paper_id: paper.id,
      citation_text: `${v.ref.authors.join(", ")}. ${v.ref.title}`.trim(),
      authors: v.ref.authors.join(", "),
      title: v.ref.title,
      year: null,
      verification_status: v.status, // "verified" | "unverified"
      verification_details:
        v.status === "verified"
          ? `Verified (${Math.round(v.score * 100)}%)`
          : `Unverified (${Math.round(v.score * 100)}%)`,
      source_url: v.sourceUrl,
      score: v.score,
    }))

    const { data: inserted, error: insertErr } = await supabase
      .from("citations")
      .insert(rows)
      .select()

    if (insertErr) {
      // still update paper status, but report citation insert error
      await supabase.from("papers").update({ status: "completed", verified_citations: verifiedCount, unverified_citations: unverifiedCount }).eq("id", paper.id)
      return Response.json({ error: "Saved paper, but failed to save citations", details: insertErr.message }, { status: 500 })
    }

    // Update paper with final counts
    await supabase
      .from("papers")
      .update({
        status: "completed",
        verified_citations: verifiedCount,
        unverified_citations: unverifiedCount,
      })
      .eq("id", paper.id)

    // Shape response similar to your current route
    const citationsOut = (inserted ?? []).map((row: any, idx: number) => {
      const v = verifications[idx]
      return {
        id: row.id,
        title: v.ref.title,
        authors: v.ref.authors,
        text: `${v.ref.authors.join(", ")}. ${v.ref.title}`.trim(),
        status: v.status,
        score: v.score,
        source_url: v.sourceUrl,
        semantic_scholar: v.semantic_scholar,
        arxiv: v.arxiv,
      }
    })

    return Response.json({
      id: paper.id,
      paper_title: extracted.paperTitle?.trim() || file.name,
      total_citations: extracted.citations.length,
      verified_count: verifiedCount,
      unverified_count: unverifiedCount,
      citations: citationsOut,
      created_at: paper.created_at,
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to verify citations" },
      { status: 500 }
    )
  }
}
