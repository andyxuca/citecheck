// app/api/verify/route.ts - ASYNC BACKGROUND PROCESSING VERSION
import { createClient } from "@/lib/supabase/server"
import { extractText } from "unpdf"
import { z } from "zod"

export const runtime = "nodejs"
export const maxDuration = 60

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

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
) {
  const { timeoutMs = 10000, ...rest } = init
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function retryFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  attempts = 2
) {
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, init)
      
      if (res && (res.status >= 500 || res.status === 429) && i < attempts - 1) {
        const backoffMs = 500 * Math.pow(2, i)
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
        const backoffMs = 500 * Math.pow(2, i)
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

function sequenceMatcherRatio(aRaw: string, bRaw: string): number {
  const a = aRaw ?? ""
  const b = bRaw ?? ""
  if (!a.length && !b.length) return 1
  if (!a.length || !b.length) return 0

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

    if (stripped.length <= 40 && stripped === stripped.toUpperCase() && !YEAR_RE.test(stripped)) {
      break
    }

    collected.push(line)
  }
  return collected.join("\n")
}

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

async function callDeepSeekJSON(prompt: string, retries = 2): Promise<unknown> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY")

  const deepseekTimeout = Number(process.env.DEEPSEEK_TIMEOUT_MS) || 20000
  let lastError: Error | null = null

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
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
          temperature: 0.1,
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

      const parsed = safeParseJSON(content)
      
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error("DeepSeek returned valid JSON but not an object")
      }

      return parsed
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`DeepSeek JSON attempt ${attempt + 1}/${retries} failed: ${lastError.message}`)
      
      if (attempt < retries - 1) {
        const backoffMs = 1000 * Math.pow(2, attempt)
        console.warn(`Retrying DeepSeek call after ${backoffMs}ms...`)
        await sleep(backoffMs)
      }
    }
  }

  throw lastError || new Error("DeepSeek JSON parsing failed after all retries")
}

function safeParseJSON(text: string): unknown {
  const trimmed = (text ?? "").trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1].trim() : trimmed

  const tryParse = (s: string) => {
    try {
      return JSON.parse(s)
    } catch (_) {
      return undefined
    }
  }

  const direct = tryParse(candidate)
  if (direct !== undefined) return direct

  let sanitized = candidate
  sanitized = sanitized.replace(/[\u0000-\u001f]+/g, "")
  sanitized = sanitized.replace(/,\s*(?=[}\]])/g, "")
  sanitized = sanitized.replace(/'([^']*)'/g, '"$1"')
  sanitized = sanitized.replace(/([\{,\s])([a-zA-Z0-9_\-]+)\s*:/g, '$1"$2":')

  const afterSanitize = tryParse(sanitized)
  if (afterSanitize !== undefined) return afterSanitize

  const objMatch = candidate.match(/\{[\s\S]*\}/)
  const arrMatch = candidate.match(/\[[\s\S]*\]/)
  const block = objMatch ? objMatch[0] : arrMatch ? arrMatch[0] : null
  if (!block) {
    throw new Error("Model did not return valid JSON.")
  }

  let blockSanitized = block.replace(/[\u0000-\u001f]+/g, "")
  blockSanitized = blockSanitized.replace(/,\s*(?=[}\]])/g, "")
  blockSanitized = blockSanitized.replace(/'([^']*)'/g, '"$1"')
  blockSanitized = blockSanitized.replace(/([\{,\s])([a-zA-Z0-9_\-]+)\s*:/g, '$1"$2":')

  const final = tryParse(blockSanitized)
  if (final !== undefined) return final

  throw new Error("Model did not return valid JSON.")
}

/* ---------------------- Semantic Scholar + arXiv ---------------------- */

type SemanticScholarItem = {
  title?: string
  authors?: { name?: string }[]
  paperId?: string
}

async function semanticScholarLookup(title: string, authors: string[] = []): Promise<SemanticScholarItem | null> {
  const query = title?.trim()
  if (!query) return null

  const ssTimeout = Number(process.env.SEMANTIC_SCHOLAR_TIMEOUT_MS) || 15000

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
    console.warn(`Semantic Scholar failed: ${e instanceof Error ? e.message : String(e)}`)
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

async function arxivLookup(title: string, authors: string[]): Promise<ArxivFields | null> {
  const cleanTitle = title?.trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ")
  if (!cleanTitle) return null

  const arxivTimeout = Number(process.env.ARXIV_TIMEOUT_MS) || 15000

  try {
    const params = new URLSearchParams({
      search_query: `ti:"${cleanTitle.replace(/"/g, "")}"`,
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
    console.warn(`arXiv failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return null
}

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
      let inter = 0
      for (const a of refSet) if (foundSet.has(a)) inter++
      authorScore = inter / refSet.size
    }
  }

  return titleScore * 0.8 + authorScore * 0.2
}

async function verifyCitation(c: Citation, minScore: number, cache?: Map<string, any>) {
  const key = `${normalize(c.title)}|${normalize((c.authors || []).join(","))}`
  if (cache?.has(key)) return cache.get(key)

  await sleep(50)

  const [ssResult, arxivResult] = await Promise.allSettled([
    semanticScholarLookup(c.title, c.authors),
    arxivLookup(c.title, c.authors),
  ])

  const ssItem = ssResult.status === 'fulfilled' ? ssResult.value : null
  const arxiv = arxivResult.status === 'fulfilled' ? arxivResult.value : null

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

  cache?.set(key, result)
  return result
}

/* ----------------------------- Background Processing ----------------------------- */

// This function runs AFTER the response is sent to the user
async function processVerificationsInBackground(
  paperId: string,
  citations: Citation[],
  minScore: number,
  userId: string
) {
  const supabase = await createClient()
  
  try {
    const envConcurrency = Number(process.env.VERIFY_LOOKUP_CONCURRENCY ?? 5)
    const CONCURRENCY = Number.isFinite(envConcurrency) && envConcurrency > 0 ? Math.min(envConcurrency, 10) : 5

    const lookupCache = new Map<string, any>()

    const verifications = await mapWithConcurrency(citations, CONCURRENCY, async (c) => {
      return verifyCitation(c, minScore, lookupCache)
    })

    const verifiedCount = verifications.filter(v => v.status === "verified").length
    const unverifiedCount = verifications.length - verifiedCount

    const rows = verifications.map(v => ({
      paper_id: paperId,
      citation_text: `${v.ref.authors.join(", ")}. ${v.ref.title}`.trim(),
      authors: v.ref.authors.join(", "),
      title: v.ref.title,
      year: null,
      verification_status: v.status,
      verification_details:
        v.status === "verified"
          ? `Verified (${Math.round(v.score * 100)}%)`
          : `Unverified (${Math.round(v.score * 100)}%)`,
      source_url: v.sourceUrl,
      score: v.score,
    }))

    const BATCH_SIZE = 100
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      const { error: chunkErr } = await supabase
        .from("citations")
        .insert(chunk)

      if (chunkErr) {
        console.error(`Failed to insert citations batch ${i}-${i+BATCH_SIZE}:`, chunkErr)
      }
    }

    // Update paper with final counts
    await supabase
      .from("papers")
      .update({
        status: "completed",
        verified_citations: verifiedCount,
        unverified_citations: unverifiedCount,
      })
      .eq("id", paperId)

    console.log(`✅ Successfully processed paper ${paperId}: ${verifiedCount} verified, ${unverifiedCount} unverified`)
  } catch (error) {
    console.error(`❌ Background processing failed for paper ${paperId}:`, error)
    
    // Mark paper as failed
    await supabase
      .from("papers")
      .update({
        status: "failed",
        error_message: error instanceof Error ? error.message : "Unknown error during verification"
      })
      .eq("id", paperId)
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

    // Create paper record with "processing" status
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

    // Start background processing (don't await!)
    processVerificationsInBackground(
      paper.id,
      extracted.citations,
      minScore,
      user.id
    ).catch(err => {
      console.error("Background processing error:", err)
    })

    // Return immediately with paper info
    return Response.json({
      id: paper.id,
      paper_title: extracted.paperTitle?.trim() || file.name,
      total_citations: extracted.citations.length,
      status: "processing",
      message: "Citations are being verified in the background. Refresh to see progress.",
      created_at: paper.created_at,
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to verify citations" },
      { status: 500 }
    )
  }
}