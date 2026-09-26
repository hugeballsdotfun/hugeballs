// Optional social links a dev can attach to a coin. They go into the coin's
// metadata JSON under the same keys pump.fun uses (`website`, `twitter`,
// `telegram`), so pump.fun's own page shows them too. Everything is normalised to
// a plain https URL and anything else is dropped; the coin page only ever
// renders links that pass `safeHttpUrl`.

export function safeHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const trim = (s) => String(s || "").trim();

// "example.com", "https://example.com/x" -> https URL
export function normalizeWebsite(input) {
  const v = trim(input);
  if (!v) return { value: "" };
  const url = safeHttpUrl(/^https?:\/\//i.test(v) ? v : "https://" + v);
  if (!url || !new URL(url).hostname.includes(".")) return { error: "Website must be a valid link, like example.com." };
  return { value: url };
}

// "@name", "name", "x.com/name", "https://twitter.com/name" -> https://x.com/name
export function normalizeTwitter(input) {
  const v = trim(input);
  if (!v) return { value: "" };
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i.exec(v) || /^@?([A-Za-z0-9_]{1,15})$/.exec(v);
  if (!m) return { error: "X / Twitter must be a handle like @yourcoin or a link to your profile." };
  return { value: `https://x.com/${m[1]}` };
}

// "@name", "t.me/name", "https://t.me/name" -> https://t.me/name
export function normalizeTelegram(input) {
  const v = trim(input);
  if (!v) return { value: "" };
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_+\-]{3,64})(?:[/?#].*)?$/i.exec(v) || /^@?([A-Za-z0-9_]{4,32})$/.exec(v);
  if (!m) return { error: "Telegram must be a group link like t.me/yourgroup." };
  return { value: `https://t.me/${m[1]}` };
}

// Returns { links: {website?, twitter?, telegram?} } or { error }.
export function normalizeLinks({ website, twitter, telegram }) {
  const out = {};
  for (const [key, fn, raw] of [
    ["website", normalizeWebsite, website],
    ["twitter", normalizeTwitter, twitter],
    ["telegram", normalizeTelegram, telegram],
  ]) {
    const r = fn(raw);
    if (r.error) return { error: r.error };
    if (r.value) out[key] = r.value;
  }
  return { links: out };
}
