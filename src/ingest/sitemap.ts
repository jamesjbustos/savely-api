export async function extractUrlsFromSitemap(
  sitemapUrl: string
): Promise<string[]> {
  const res = await fetch(sitemapUrl, {
    headers: { accept: "application/xml,text/xml,*/*" },
  });
  if (!res.ok) throw new Error(`Fetch sitemap failed: ${res.status}`);
  const xml = await res.text();

  // super light xml loc extractor (works for standard sitemaps)
  const urls: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    urls.push(m[1].trim());
  }
  return urls;
}
