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
  export async function POST(request: Request) {
    // We'll stream progress updates as SSE-like `data: {...}\n\n` chunks.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const push = (obj: any) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
          } catch (e) {
            // ignore
          }
        }

        const finish = (obj?: any) => {
          if (obj) push(obj)
          try { controller.close() } catch (e) {}
        }

        try {
          const supabase = await createClient()
          const { data: { user } } = await supabase.auth.getUser()
          if (!user) {
            push({ type: 'error', message: 'Unauthorized' })
            return finish()
          }

          const formData = await request.formData()
          const file = formData.get("file") as File | null
          const minScoreRaw = formData.get("min_score")
          const minScore = typeof minScoreRaw === "string" ? Number(minScoreRaw) : 0.5

          if (!file || file.type !== "application/pdf") {
            push({ type: 'error', message: 'Please upload a valid PDF file' })
            return finish()
          }
          if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
            push({ type: 'error', message: 'min_score must be between 0 and 1' })
            return finish()
          }

          push({ type: 'progress', message: 'Extracting PDF text' })
          // Extract PDF text
          let fullText = ""
          try {
            const bytes = new Uint8Array(await file.arrayBuffer())
            const out = await extractText(bytes, { mergePages: true })
            fullText = Array.isArray(out.text) ? out.text.join("\n") : String(out.text ?? "")
          } catch (e) {
            push({ type: 'error', message: 'Failed to parse PDF file' })
            return finish()
          }

          push({ type: 'progress', message: 'Finding references section' })
          const referencesSection = findReferencesSection(fullText)
          if (!referencesSection.trim()) {
            push({ type: 'error', message: 'Could not find references section in the PDF' })
            return finish()
          }

          push({ type: 'progress', message: 'Extracting citations with DeepSeek' })
          const prompt =
            `Extract citations from the references section below.\n` +
            `Return strict JSON only: an object with keys ` +
            `"paperTitle" (string) and "citations" (array of { "title": string, "authors": string[] }).\n` +
            `No markdown. No extra keys.\n\n` +
            referencesSection

          const raw = await callDeepSeekJSON(prompt)
          const extracted = ExtractedCitationsSchema.parse(raw)

          if (!extracted.citations.length) {
            push({ type: 'error', message: 'Could not extract citations from the PDF' })
            return finish()
          }

          push({ type: 'progress', message: 'Creating paper record' })
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
            push({ type: 'error', message: 'Failed to save paper' })
            return finish()
          }

          // Verify citations with limited concurrency to avoid serverless timeouts
          const envConcurrency = Number(process.env.VERIFY_LOOKUP_CONCURRENCY ?? 4)
          const CONCURRENCY = Number.isFinite(envConcurrency) && envConcurrency > 0 ? Math.min(envConcurrency, 20) : 4

          // Per-request in-memory cache to deduplicate lookups for identical citations
          const lookupCache = new Map<string, any>()

          push({ type: 'progress', message: 'Verifying citations' })
          const verifications = await mapWithConcurrency(extracted.citations, CONCURRENCY, async (c, idx) => {
            // Optionally push per-n N progress updates
            if (idx % Math.max(1, Math.floor(extracted.citations.length / 4)) === 0) {
              push({ type: 'progress', message: `Verifying citations (${idx + 1}/${extracted.citations.length})` })
            }
            return verifyCitation(c, minScore, lookupCache)
          })

          const verifiedCount = verifications.filter(v => v.status === "verified").length
          const unverifiedCount = verifications.length - verifiedCount

          push({ type: 'progress', message: 'Saving citation results' })
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
              push({ type: 'error', message: 'Saved paper, but failed to save citations' })
              return finish()
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

          // Send final result then close stream
          push({ type: 'result', data: {
            id: paper.id,
            paper_title: extracted.paperTitle?.trim() || file.name,
            total_citations: extracted.citations.length,
            verified_count: verifiedCount,
            unverified_count: unverifiedCount,
            citations: citationsOut,
            created_at: paper.created_at,
          } })

          return finish()
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`)) } catch (e) {}
          try { controller.close() } catch (e) {}
        }
      }
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

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

  const deepseekTimeout = Number(process.env.DEEPSEEK_TIMEOUT_MS) || 30000

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
    const ssTimeout = Number(process.env.SEMANTIC_SCHOLAR_TIMEOUT_MS) || 15000
    const res = await retryFetch(
      `https://api.semanticscholar.org/graph/v1/paper/search/match?${params.toString()}`,
      { headers: { Accept: "application/json" }, timeoutMs: ssTimeout }
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
    const arxivTimeout = Number(process.env.ARXIV_TIMEOUT_MS) || 20000
    const res = await retryFetch(`https://export.arxiv.org/api/query?${params.toString()}`, {
      timeoutMs: arxivTimeout,
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

async function verifyCitation(c: Citation, minScore: number, cache?: Map<string, any>) {
  const key = `${normalize(c.title)}|${normalize((c.authors || []).join(","))}`
  if (cache?.has(key)) return cache.get(key)

  // Run lookups in parallel to reduce per-citation latency and capture errors
  const [ssSettled, arxivSettled] = await Promise.allSettled([
    semanticScholarLookup(c.title),
    arxivLookup(c.title, c.authors),
  ])

  const ssItem = ssSettled.status === "fulfilled" ? ssSettled.value : null
  const ssError = ssSettled.status === "rejected" ? ssSettled.reason : null

  const arxiv = arxivSettled.status === "fulfilled" ? arxivSettled.value : null
  const arxivError = arxivSettled.status === "rejected" ? arxivSettled.reason : null

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

  // Optionally include lookup error messages for debugging when enabled
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
    const envConcurrency = Number(process.env.VERIFY_LOOKUP_CONCURRENCY ?? 4)
    const CONCURRENCY = Number.isFinite(envConcurrency) && envConcurrency > 0 ? Math.min(envConcurrency, 20) : 4

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
