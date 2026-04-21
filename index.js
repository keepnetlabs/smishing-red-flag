function corsHeaders(){ return { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type, Authorization", "Access-Control-Max-Age":"86400" }; }

/* ===== LANGUAGE ===== */

function getRequestedLanguage(language="en"){
  const raw = String(language || "").trim();
  return raw || "en";
}
function getPromptLanguageLiteral(language="en"){
  const requestedLanguage = getRequestedLanguage(language)
    .replace(/[\x00-\x1f\x7f]+/g," ")
    .replace(/\s+/g," ")
    .trim()
    .slice(0, 120);
  return JSON.stringify(requestedLanguage || "en");
}

/* ===== UTILS ===== */

function parseMessageJSON(r){
  const out=r?.output;
  const item=Array.isArray(out)?out.find(i=>i?.type==="message"):out;
  const text=item?.content?.[0]?.text;
  if(!text) throw new Error("No message content in r.output");
  return JSON.parse(text);
}
function sanitizeTooltip(txt){
  const map={ "&":"&amp;", "'":"&#39;", '"':"&quot;", "<":"&lt;", ">":"&gt;", "\n":" ", "\r":" ", "\t":" " };
  let out=String(txt||"").replace(/[&'"<>]|\n|\r|\t/g,m=>map[m]).replace(/\s{2,}/g," ").trim();
  if(out.length>240) out=out.slice(0,240);
  out=out.replace(/<\/?[^>]+>/g,"");
  return out;
}
function escapeHtml(txt){
  const map={ "&":"&amp;", "'":"&#39;", '"':"&quot;", "<":"&lt;", ">":"&gt;" };
  return String(txt||"").replace(/[&'"<>]/g,m=>map[m]);
}

/* ===== SIGNAL EXTRACTION ===== */

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>"'()]*/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

const SHORTENERS = new Set([
  "bit.ly","tinyurl.com","t.co","goo.gl","ow.ly","is.gd","buff.ly","rebrand.ly",
  "cutt.ly","rb.gy","shorturl.at","tiny.cc","t.ly","s.id","soo.gd","qr.ae",
  "qr.net","adf.ly","lnkd.in","tr.im","po.st","u.to","v.gd","x.co","shrtco.de",
  "zpr.io","bl.ink","dub.sh","short.io","trib.al","fb.me","ht.ly","mcaf.ee"
]);

function hostFromUrl(u){
  try{
    const prefixed = /^https?:\/\//i.test(u) ? u : `http://${u.replace(/^\/+/,"")}`;
    return new URL(prefixed).hostname.toLowerCase();
  }catch{
    const m = String(u).toLowerCase().match(/^(?:https?:\/\/)?([^\/\s]+)/);
    return m ? m[1] : "";
  }
}
function hasIdnOrPunycode(host){
  if(!host) return false;
  if(host.includes("xn--")) return true;
  return /[^\x00-\x7f]/.test(host);
}
const TWO_PART_SUFFIXES = new Set([
  "co.uk","co.jp","co.kr","co.nz","co.za","co.in","co.il","co.id","co.th","co.ke",
  "com.au","com.br","com.tr","com.cn","com.hk","com.sg","com.mx","com.ar","com.pl",
  "com.ph","com.tw","com.my","com.vn","com.pe","com.co","com.ua","com.sa","com.eg",
  "com.ng","com.pk","com.bd","com.py","com.uy","com.ec","com.bo",
  "net.au","net.br","net.cn","net.tr","net.uk",
  "org.uk","org.au","org.br","org.tr","org.il",
  "gov.uk","gov.au","gov.tr","ac.uk","ac.jp","ac.nz","ac.kr","ac.il",
  "or.jp","ne.jp","go.jp"
]);
function etldPlusOne(host){
  if(!host) return "";
  const parts = host.split(".");
  if(parts.length<2) return host;
  const last2 = parts.slice(-2).join(".");
  if(parts.length >= 3 && TWO_PART_SUFFIXES.has(last2)){
    return parts.slice(-3).join(".");
  }
  return last2;
}
function hasPathOrQuery(cleanedUrl, host){
  const stripped = cleanedUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const hostBare = host.replace(/^www\./i, "");
  const rest = stripped.slice(hostBare.length);
  return rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}
function extractLinks(text){
  const out = [];
  const seen = new Set();
  const matches = text.match(URL_RE) || [];
  for(const raw of matches){
    const cleaned = raw.replace(/[.,;:!?)\]]+$/,"");
    if(!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    const host = hostFromUrl(cleaned);
    if(!host || !host.includes(".")) continue;
    const etld = etldPlusOne(host);
    out.push({
      url: cleaned,
      host,
      etldPlusOne: etld,
      isShortener: SHORTENERS.has(host) || SHORTENERS.has(etld),
      hasIdn: hasIdnOrPunycode(host),
      pathOrQuery: hasPathOrQuery(cleaned, host)
    });
  }
  return out;
}
function extractPhones(text){
  const out = [];
  const seen = new Set();
  const matches = text.match(PHONE_RE) || [];
  for(const raw of matches){
    const digits = raw.replace(/\D/g,"");
    if(digits.length < 7 || digits.length > 15) continue;
    const cleaned = raw.trim();
    if(seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push({ raw: cleaned, digits });
  }
  return out;
}

/* ===== SPAN WRAPPING ===== */

function findMatchOffsets(text, match, usedRanges){
  if(!match || typeof match !== "string") return null;
  let from = 0;
  while(from <= text.length){
    const idx = text.indexOf(match, from);
    if(idx === -1) return null;
    const end = idx + match.length;
    const overlap = usedRanges.some(([a,b]) => idx < b && end > a);
    if(!overlap) return [idx, end];
    from = idx + 1;
  }
  return null;
}
function resolveAndLocateEdits(text, rawEdits){
  const severityRank = r => r === "high" ? 2 : (r === "medium" ? 1 : 0);
  const normalized = (rawEdits || [])
    .filter(e => e && typeof e.match === "string" && e.match.length > 0 && typeof e.tooltipMessage === "string")
    .map(e => ({
      match: e.match,
      risk: e.risk === "high" ? "high" : "medium",
      tooltipMessage: e.tooltipMessage
    }))
    .sort((a,b) => severityRank(b.risk) - severityRank(a.risk));

  const located = [];
  const used = [];
  for(const e of normalized){
    const range = findMatchOffsets(text, e.match, used);
    if(!range) continue;
    located.push({ start: range[0], end: range[1], risk: e.risk, tooltipMessage: e.tooltipMessage });
    used.push(range);
  }
  return located;
}
function applySpans(text, locatedEdits){
  if(!locatedEdits.length) return escapeHtml(text);
  const sorted = [...locatedEdits].sort((a,b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for(const e of sorted){
    if(e.start < cursor) continue;
    out += escapeHtml(text.slice(cursor, e.start));
    const inner = escapeHtml(text.slice(e.start, e.end));
    const tip = sanitizeTooltip(e.tooltipMessage);
    out += `<span class='flagged-area' data-flag-tooltip='${tip}'>${inner}</span>`;
    cursor = e.end;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}

/* ===== PROMPT ===== */

function buildSystemPrompt(language){
  const requestedLanguage = getPromptLanguageLiteral(language);
  return String.raw`
You are a smishing (SMS phishing) red-flag annotator operating in PATCH MODE.

INPUT is a JSON object:
{
  "text": "<the SMS body, plain text>",
  "links": [ { "url": "...", "host": "...", "etldPlusOne": "...", "isShortener": true|false, "hasIdn": true|false, "pathOrQuery": true|false } ],
  "phones": [ { "raw": "...", "digits": "..." } ]
}

OUTPUT is a single JSON object, no prose, no code fences:
{
  "edits": [
    { "match": "<verbatim substring of text>", "risk": "high"|"medium", "tooltipMessage": "<complete sentence in ${requestedLanguage}>" }
  ]
}

===== PATCH MODE RULES =====
• "match" MUST be an exact, case-sensitive, verbatim substring of "text" (no paraphrase, no added/removed whitespace, no normalization of punctuation).
• Choose the MINIMAL span that carries the red flag — a URL, a phone number, or a short phrase (prefer 1–8 words). Never wrap the entire message.
• Spans MUST NOT overlap. If a short span already carries the signal, do not also emit a larger enclosing span.
• Emit at most 8 edits. If nothing is flagged, return {"edits": []}.
• Do NOT invent text that is not in "text". If you cannot find a verbatim span for a cue, skip it.

===== TOOLTIP STYLE =====
• Every tooltipMessage MUST be a single complete natural sentence in ${requestedLanguage}.
• Begin with a short severity label that clearly means either "high risk" or "medium risk" in ${requestedLanguage}, matching the "risk" value. Do NOT use the literal English words "High risk" or "Medium risk"; express this meaning naturally in ${requestedLanguage}.
• ≤240 characters. No lists. No emoji. No brand logos. State the single strongest reason.
• Do not repeat the flagged text inside the tooltip.

===== HIGH-SEVERITY RULES =====
Flag as "high" when any of these apply:

H1. BANKING / OTP / PIN / CARD. SMS referencing one-time codes, PINs, CVV, full card numbers, account verification, or "your account will be blocked", paired with a link or a callback number. Banks never ask for OTP/PIN by SMS — any such request is always high.

H2. CREDENTIAL / LOGIN / MFA RESET. Unsolicited SMS instructing the recipient to log in, reset a password, confirm identity, re-enable MFA, or "verify your account" via a link.

H3. DELIVERY / PARCEL / CUSTOMS. Missed delivery, pending package, customs or shipping fee, reschedule-delivery lures combined with a link or small-fee request.

H4. TAX / GOVERNMENT / COURT / POLICE. Impersonation of tax authority, social-security/pension, court summons, fines, police/law-enforcement, subpoena — especially with a link or callback.

H5. PRIZE / LOTTERY / REFUND / GIFT-CARD. "You have won", unexpected refund, gift-card offer, compensation, sweepstakes, combined with a link or callback.

H6. IT / HR / PAYROLL / CORPORATE. IT helpdesk, mailbox quota, Microsoft/Office 365/Google/Okta/VPN, HR payroll, direct-deposit change, benefits enrollment lures with a link or callback.

H7. CRYPTO / INVESTMENT. Wallet-recovery, seed-phrase, exchange-verification, unsolicited "investment opportunity", pig-butchering approach.

H8. SHORTENER OR BRAND-IMPERSONATION URL + AUTH/PAYMENT CUE. A URL in "links" with isShortener:true, hasIdn:true, or a suspicious subdomain pattern (e.g. brand name used as subdomain of an unrelated domain) combined with credential / payment / verify / confirm / validate / unlock / restore wording anywhere in the text.

H9. FAMILY / EMERGENCY IMPERSONATION. "Hi mom/dad, my phone broke", "this is your son/daughter, new number", "please send money / gift card / wire" — emergency social-engineering.

H10. CALLBACK + AUTHORITY / FRAUD-ALERT. Phone number to call combined with bank/fraud/authority/suspension framing. Flag the phone number span.

===== MEDIUM-SEVERITY RULES =====
Flag as "medium" when any of these apply (and none of H1–H10 fire for that span):

M1. Any URL shortener link present (isShortener:true) without clear credential/payment CTA.
M2. Urgency / deadline / suspension threat / "immediate action" wording without a concrete credential or payment CTA.
M3. Unknown-sender greeting using generic "hello", "Re: your account", "update your info", "we tried to reach you" without a specific brand.
M4. Callback number with urgency but without bank/authority framing.
M5. IDN/punycode host (hasIdn:true) in any link, regardless of wording.
M6. Brand name mentioned in text but the linked host's eTLD+1 does not match that brand.

===== SPAN CHOICE GUIDE =====
• Links: flag the URL itself (use the exact substring as it appears in "text", including any trailing punctuation only if it is actually part of the URL in "text").
• Phone numbers: flag the phone number as it appears in "text".
• Urgency / impersonation cues: flag the strongest phrase (≤8 words).
• Emergency/family lures: flag the lure phrase.
• Do not flag a URL twice. Do not flag a phrase and then also flag a sub-word inside it.

===== FALSE-POSITIVE GUARDS =====
• Do NOT flag purely informational one-time codes with no link/CTA and no pressure (e.g. "Your verification code is 123456. Do not share.").
• Do NOT flag simple transactional confirmations without action CTA (e.g. "Your order has shipped") unless combined with a shortener, IDN host, or authority-pressure cue.
• Do NOT flag a bare URL that clearly points to the claimed brand's own eTLD+1 unless combined with urgency + credential CTA.
• Do NOT flag appointment reminders, 2FA push notifications, or delivery tracking that omit links and CTAs.

===== LANGUAGE =====
• Infer cues semantically across any language that appears in "text"; do NOT rely on fixed dictionaries.
• Tooltips MUST always be in ${requestedLanguage}, regardless of the language of "text".

Return JSON only. No explanation, no code fences, no trailing commentary.
`;
}

/* ===== HANDLER ===== */

export default {
  async fetch(request, env){
    if(request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if(request.method !== "POST"){
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders() });
    }

    let body;
    try{ body = await request.json(); }
    catch{ return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() }); }

    const text = typeof body?.text === "string" ? body.text : "";
    const requestedLanguage = getRequestedLanguage(body?.language);

    if(!text.trim()){
      return Response.json({ template: "" }, { headers: { ...corsHeaders(), "content-type": "application/json" } });
    }

    const links = extractLinks(text);
    const phones = extractPhones(text);

    const params = {
      input: [
        { role: "system", content: buildSystemPrompt(requestedLanguage) },
        { role: "user", content: JSON.stringify({ text, links, phones }) }
      ],
      temperature: 0
    };

    let out;
    try{
      const r = await env.AI.run("@cf/openai/gpt-oss-120b", params);
      out = parseMessageJSON(r);
    }catch(e){
      return Response.json({ error: "AI invocation failed", detail: String(e) }, { status: 500, headers: corsHeaders() });
    }

    const rawEdits = Array.isArray(out?.edits) ? out.edits : [];
    const located = resolveAndLocateEdits(text, rawEdits);
    const template = applySpans(text, located);

    return Response.json({ template }, { headers: { ...corsHeaders(), "content-type": "application/json" } });
  }
};
