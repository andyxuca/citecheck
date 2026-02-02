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

/* ----------------------------- Constants ----------------------------- */

// DeepSeek context window limits
// 64K tokens total (input + output), ~4 chars per token average
// Reserve tokens for: system prompt (~200), response format (~1000), output (~4000)
const MAX_INPUT_TOKENS = 1000 // Conservative limit for input
const CHARS_PER_TOKEN = 4 // Average estimate
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * CHARS_PER_TOKEN
const CHUNK_OVERLAP_CHARS = 2000 // Overlap to avoid splitting citations mid-text

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

// Serverless-safe timeout wrapper with better error messages
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
) {
  const { timeoutMs = 15000, ...rest } = init
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms for ${url}`)
    }
    throw error
  } finally {
    clearTimeout(t)
  }
}

// Small helper to pause
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Improved retry wrapper with better backoff and error handling
async function retryFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  attempts = 5 // Increased from 4
) {
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, init)
      
      // If server error or rate limit, retry with exponential backoff
      if (res && (res.status >= 500 || res.status === 429) && i < attempts - 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, i), 10000) // Cap at 10s
        console.warn(`retryFetch: status ${res.status} for ${url}, attempt ${i + 1}, waiting ${backoffMs}ms`)
        await sleep(backoffMs)
        continue
      }
      return res
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`retryFetch: error for ${url} on attempt ${i + 1}: ${msg}`)
      
      if (i < attempts - 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, i), 10000)
        console.warn(`Retrying after ${backoffMs}ms...`)
        await sleep(backoffMs)
        continue
      }
      throw lastErr
    }
  }
  throw lastErr
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

/* ----------------------------- Chunking ----------------------------- */

/**
 * Split references section into chunks that fit within DeepSeek's token limits.
 * Tries to split on citation boundaries (blank lines or numbered entries).
 */
function chunkReferencesSection(referencesText: string): string[] {
  // If small enough, return as single chunk
  if (referencesText.length <= MAX_INPUT_CHARS) {
    return [referencesText]
  }

  const chunks: string[] = []
  const lines = referencesText.split(/\r?\n/)
  
  let currentChunk: string[] = []
  let currentSize = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineSize = line.length + 1 // +1 for newline

    // Check if adding this line would exceed limit
    if (currentSize + lineSize > MAX_INPUT_CHARS && currentChunk.length > 0) {
      // Save current chunk
      chunks.push(currentChunk.join("\n"))
      
      // Start new chunk with overlap (last few lines for context)
      const overlapLines = Math.min(5, currentChunk.length)
      currentChunk = currentChunk.slice(-overlapLines)
      currentSize = currentChunk.reduce((sum, l) => sum + l.length + 1, 0)
    }

    currentChunk.push(line)
    currentSize += lineSize
  }

  // Add final chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n"))
  }

  return chunks
}

/**
 * Deduplicate citations by title (case-insensitive).
 * Keeps first occurrence of each unique title.
 */
function deduplicateCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>()
  const unique: Citation[] = []

  for (const cit of citations) {
    const normalizedTitle = normalize(cit.title)
    if (!normalizedTitle || seen.has(normalizedTitle)) continue
    
    seen.add(normalizedTitle)
    unique.push(cit)
  }

  return unique
}

/* ----------------------------- DeepSeek ----------------------------- */

async function callDeepSeekJSON(prompt: string): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY")

  const deepseekTimeout = Number(process.env.DEEPSEEK_TIMEOUT_MS) || 45000 // Increased timeout

  const res = await fetchWithTimeout("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    timeoutMs: deepseekTimeout,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0, // More consistent output
      max_tokens: 4000, // Explicit output limit
    }),
  })

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

  // Add better error context
  try {
    return safeParseJSON(content)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`Failed to parse DeepSeek JSON. Error: ${msg}\nContent preview: ${content.slice(0, 500)}`)
    throw new Error(`Failed to parse DeepSeek JSON output: ${msg}\nContent: ${content}`)
  }
}

function safeParseJSON(text: string): unknown {
  const trimmed = (text ?? "").trim()

  // Strip code fences if present
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1].trim() : trimmed

  // Remove trailing commas (common JSON error)
  const cleaned = candidate
    .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas before ] or }
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim()

  // Try parse directly
  try {
    return JSON.parse(cleaned)
  } catch (firstError) {
    // Fallback: extract first {...} block
    const obj = cleaned.match(/\{[\s\S]*\}/)
    if (!obj) {
      const msg = firstError instanceof Error ? firstError.message : String(firstError)
      throw new Error(`Model did not return valid JSON. Original error: ${msg}`)
    }
    
    try {
      return JSON.parse(obj[0])
    } catch (secondError) {
      const msg = secondError instanceof Error ? secondError.message : String(secondError)
      throw new Error(`Failed to parse extracted JSON object: ${msg}`)
    }
  }
}

/**
 * Extract citations from references section, handling chunking if needed.
 * Returns combined results from all chunks with deduplication.
 */
async function extractCitationsFromReferences(
  referencesSection: string,
  chunkIndex?: number,
  totalChunks?: number
): Promise<{ paperTitle: string; citations: Citation[] }> {
  const chunks = chunkReferencesSection(referencesSection)
  
  console.log(`Processing ${chunks.length} chunk(s) for citation extraction`)

  let allCitations: Citation[] = []
  let paperTitle = ""

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    
    // Add chunk context to prompt if multiple chunks
    const chunkInfo = chunks.length > 1 
      ? `\n\nNote: This is chunk ${i + 1} of ${chunks.length}. Extract all citations from this section.`
      : ""

    const prompt =
      `Extract citations from the references section below.\n` +
      `You MUST return ONLY valid JSON with NO markdown, NO code fences, NO trailing commas.\n` +
      `Required format: {"paperTitle": "string", "citations": [{"title": "string", "authors": ["string"]}]}\n` +
      `Each citation must have a title (non-empty string) and authors (array of strings, may be empty).\n` +
      `If you cannot determine the paper title, use an empty string.${chunkInfo}\n\n` +
      chunk

    console.log(`Calling DeepSeek for chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`)

    const raw = await callDeepSeekJSON(prompt)
    const extracted = ExtractedCitationsSchema.parse(raw)

    // Use paper title from first chunk
    if (i === 0 && extracted.paperTitle) {
      paperTitle = extracted.paperTitle
    }

    allCitations.push(...extracted.citations)

    // Rate limiting: small delay between chunks
    if (i < chunks.length - 1) {
      await sleep(1000)
    }
  }

  // Deduplicate citations across chunks
  const uniqueCitations = deduplicateCitations(allCitations)
  
  console.log(`Extracted ${allCitations.length} total citations, ${uniqueCitations.length} unique`)

  return {
    paperTitle,
    citations: uniqueCitations,
  }
}

/* ---------------------- Semantic Scholar + arXiv ---------------------- */

type SemanticScholarItem = {
  title?: string
  authors?: { name?: string }[]
  paperId?: string
}

// Improved Semantic Scholar lookup with multiple fallback strategies
async function semanticScholarLookup(title: string, authors: string[] = []): Promise<SemanticScholarItem | null> {
  const query = title?.trim()
  if (!query) return null

  // Increased timeout for better reliability
  const ssTimeout = Number(process.env.SEMANTIC_SCHOLAR_TIMEOUT_MS) || 25000

  // Strategy 1: Try exact match endpoint first (more reliable)
  try {
    const params = new URLSearchParams({
      query,
      limit: "1",
      fields: "title,authors,paperId",
    })

    const res = await retryFetch(
      `https://api.semanticscholar.org/graph/v1/paper/search/match?${params.toString()}`,
      { 
        headers: { Accept: "application/json" }, 
        timeoutMs: ssTimeout 
      }
    )

    if (res.ok) {
      const data = await res.json().catch(() => null)
      const arr = data?.data
      if (Array.isArray(arr) && arr.length > 0) {
        return arr[0] as SemanticScholarItem
      }
    }
  } catch (e) {
    console.warn(`Semantic Scholar match endpoint failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Strategy 2: Try bulk search endpoint as fallback
  try {
    const searchParams = new URLSearchParams({
      query,
      limit: "3", // Get more results to find better matches
      fields: "title,authors,paperId",
    })

    const res = await retryFetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?${searchParams.toString()}`,
      { 
        headers: { Accept: "application/json" }, 
        timeoutMs: ssTimeout 
      }
    )

    if (res.ok) {
      const data = await res.json().catch(() => null)
      const arr = data?.data
      if (Array.isArray(arr) && arr.length > 0) {
        // Find best match by title similarity
        let bestMatch = arr[0]
        let bestScore = 0

        for (const item of arr) {
          if (item.title) {
            const score = sequenceMatcherRatio(normalize(title), normalize(item.title))
            if (score > bestScore) {
              bestScore = score
              bestMatch = item
            }
          }
        }

        return bestMatch as SemanticScholarItem
      }
    }
  } catch (e) {
    console.warn(`Semantic Scholar search endpoint failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return null
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

// Improved arXiv lookup with better query construction and parsing
async function arxivLookup(title: string, authors: string[]): Promise<ArxivFields | null> {
  const cleanTitle = title?.trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ")
  if (!cleanTitle) return null

  // Increased timeout for better reliability
  const arxivTimeout = Number(process.env.ARXIV_TIMEOUT_MS) || 30000

  // Strategy 1: Search by title only (more reliable)
  try {
    const params = new URLSearchParams({
      search_query: `ti:"${cleanTitle.replace(/"/g, "")}"`,
      start: "0",
      max_results: "5", // Get more results for better matching
    })

    const res = await retryFetch(
      `https://export.arxiv.org/api/query?${params.toString()}`,
      {
        timeoutMs: arxivTimeout,
        headers: { Accept: "application/atom+xml, text/xml" },
      }
    )

    if (res.ok) {
      const xml = await res.text()
      const entries = parseArxivXML(xml)
      
      if (entries.length > 0) {
        // Find best match by title similarity
        let bestMatch = entries[0]
        let bestScore = 0

        for (const entry of entries) {
          if (entry.title) {
            const score = sequenceMatcherRatio(normalize(title), normalize(entry.title))
            if (score > bestScore) {
              bestScore = score
              bestMatch = entry
            }
          }
        }

        return bestMatch
      }
    }
  } catch (e) {
    console.warn(`arXiv title search failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Strategy 2: Try with title AND first author if available
  if (authors?.[0]) {
    try {
      const params = new URLSearchParams({
        search_query: `ti:"${cleanTitle.replace(/"/g, "")}" AND au:"${authors[0].replace(/"/g, "")}"`,
        start: "0",
        max_results: "3",
      })

      const res = await retryFetch(
        `https://export.arxiv.org/api/query?${params.toString()}`,
        {
          timeoutMs: arxivTimeout,
          headers: { Accept: "application/atom+xml, text/xml" },
        }
      )

      if (res.ok) {
        const xml = await res.text()
        const entries = parseArxivXML(xml)
        if (entries.length > 0) {
          return entries[0]
        }
      }
    } catch (e) {
      console.warn(`arXiv title+author search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return null
}

// Helper to parse multiple arXiv entries
function parseArxivXML(xml: string): ArxivFields[] {
  const entries: ArxivFields[] = []
  const entryMatches = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/gi)]

  for (const match of entryMatches) {
    const entry = match[0]

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i)
    const authorMatches = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    const idMatch = entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/i)

    const parsedTitle = titleMatch?.[1]
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : null

    const parsedAuthors = authorMatches
      .map(m => m[1]?.replace(/\s+/g, " ").trim())
      .filter((x): x is string => !!x)

    if (parsedTitle) {
      entries.push({
        title: parsedTitle,
        authors: parsedAuthors,
        arxivId: idMatch?.[1],
      })
    }
  }

  return entries
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
      // Exact set intersection
      let inter = 0
      for (const a of refSet) if (foundSet.has(a)) inter++
      authorScore = inter / refSet.size
    }
  }

  // Weight title more heavily since it's more reliable
  return titleScore * 0.8 + authorScore * 0.2
}

async function verifyCitation(c: Citation, minScore: number, cache?: Map<string, any>) {
  const key = `${normalize(c.title)}|${normalize((c.authors || []).join(","))}`
  if (cache?.has(key)) return cache.get(key)

  // Add delay between requests to avoid rate limiting
  await sleep(100)

  let ssItem: SemanticScholarItem | null = null
  let ssError: any = null
  let arxiv: ArxivFields | null = null
  let arxivError: any = null

  // Try Semantic Scholar first (generally more reliable)
  try {
    ssItem = await semanticScholarLookup(c.title, c.authors)
  } catch (e) {
    ssError = e
    console.warn(`Semantic Scholar lookup error for "${c.title}": ${e instanceof Error ? e.message : String(e)}`)
  }

  // Always try arXiv as well for academic papers
  try {
    arxiv = await arxivLookup(c.title, c.authors)
  } catch (e) {
    arxivError = e
    console.warn(`arXiv lookup error for "${c.title}": ${e instanceof Error ? e.message : String(e)}`)
  }

  const ss = extractSemanticScholarFields(ssItem)
  const ssScore = ssItem ? scoreMatchFields(c.title, c.authors, ss.title, ss.authors) : 0
  const arxivScore = arxiv ? scoreMatchFields(c.title, c.authors, arxiv.title, arxiv.authors) : 0

  const score = Math.max(ssScore, arxivScore)

  let status: "verified" | "unverified" = score >= minScore ? "verified" : "unverified"
  let sourceUrl: string | null = null

  if (status === "verified") {
    if (ssScore >= arxivScore && ss.paperId) sourceUrl = `https://www.semanticscholar.org/paper/${ss.paperId}`
    else if (arxiv?.arxivId) sourceUrl = `https://arxiv.org/abs/${arxiv.arxivId}`
  }

  const result = {
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

  // Include lookup errors for debugging
  if (process.env.VERIFY_DEBUG === "1") {
    ;(result as any).lookup_errors = {
      semanticScholar: ssError ? (ssError instanceof Error ? ssError.message : String(ssError)) : null,
      arXiv: arxivError ? (arxivError instanceof Error ? arxivError.message : String(arxivError)) : null,
    }
  }

  cache?.set(key, result)
  return result
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

    console.log(`References section: ${referencesSection.length} characters`)

    // Extract citations with automatic chunking if needed
    const extracted = await extractCitationsFromReferences(referencesSection)

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

    // Reduced concurrency for better reliability (avoid overwhelming APIs)
    const envConcurrency = Number(process.env.VERIFY_LOOKUP_CONCURRENCY ?? 2)
    const CONCURRENCY = Number.isFinite(envConcurrency) && envConcurrency > 0 ? Math.min(envConcurrency, 5) : 2

    // Per-request in-memory cache to deduplicate lookups for identical citations
    const lookupCache = new Map<string, any>()

    const verifications = await mapWithConcurrency(extracted.citations, CONCURRENCY, async (c) => {
      return verifyCitation(c, minScore, lookupCache)
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

    const BATCH_SIZE = 100
    const allInserted: any[] = []
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      const { data: chunkInserted, error: chunkErr } = await supabase
        .from("citations")
        .insert(chunk)
        .select()

      if (chunkErr) {
        // still update paper status, but report citation insert error
        await supabase
          .from("papers")
          .update({ status: "completed", verified_citations: verifiedCount, unverified_citations: unverifiedCount })
          .eq("id", paper.id)
        return Response.json({ error: "Saved paper, but failed to save citations", details: chunkErr.message }, { status: 500 })
      }

      allInserted.push(...(chunkInserted ?? []))
    }

    const inserted = allInserted

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