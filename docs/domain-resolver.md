Goal: Add base domain to each brand in my db, for instance Amazon would be amazon.com. Steam would be store.steampowered.com.

How? Using googles json search api we can query our brand and retrieve the most relevant result. (i have my api key and cx key ready)

Things to keep in mind

- Gap, Gap Kids, Baby Gap are brands in our db, however, each of these fall under the same domain gap.com. So our db should support the same domain for certain brands.
- Some stores are primarily know for their subdomain. For instance, Steam when google searched returns store.steampowered.com. So our db should take into account subdomains as well
- We will not be saving paths, for instance: "https://www.gap.com/browse/gapkids?cid=6170". Our exntension in the frontend will either call using the domain, or subdomain, not paths.
- We want to make sure the domain we're saving in our db is with high confidence a great match, if some need to be reviewed this should be part of a final report.
- Potentially there will be brands that we're formely know as their brand name, but may have been acquired. For instance the brand OshKosh B'Gosh used to be on its domain however since it was aquired by carters, the first url we get back is carters.com.
- Some brands and their sub brands do have their own domain for instance, Pottery Barn has potterybarn.com and pbteen.com. Both show up when search the brand name.
- Hostname should be clean in the final result: amazon.com or store.steampowered.com
- We should filter obvious junk like facebook.com, x.com, wikipedia.org, yelp.com, tripadvisor.com, etc.
- Like I stated not every brand will operate under the same name in instances like OshKosh B'Gosh where it was aquired. But overall we do want to compute how well it compares to the brand name for instance, If brand_root === domain_root → score very high (e.g. 0.95+). or +0.7 if root matches core brand token, +0.2 if domain is first result in Google, −0.3 if contains “review”, “info”, “coupon”, etc. This will allow us to o separate 90% of good vs bad candidates, we don't blindly want to take the first result, even though the google keyword search is really good.
- Collect top 3–5 results, extract hostnames, drop social/review/info sites.
- If candidate score is high enough Auto-accept and insert into brand_domains, If score is moderate put it into a “needs review” table/CSV alongside the brand so we can easily push to the db later if we need to, brand id too if possible. If score is very low we add it to separate table/csv that will require a final review as well.
- I've removed as much duplicates as i could in our db but there could be a situation where my db has "Atom Tickets" and "Atom Movie Tickets" as brand names and they both resolve to the same domain. You decide how to handle this but if it needs to be added to a review csv that's fine, i can come and manually merge the brands if needed.
- Adjust my schema as needed, if you need to design it better we can do that. Not sure if we need to make a parent brand group for situations like Gap and Gap kids, but if its too complicated or going to have a lot incomplete data than not worth it. You can review my schema and make any necessary changes.
- Page title check (from the search result snippet)
  - If the search result title contains the brand name strongly (“Best Buy: Official Online Store” etc.), bump the confidence.
- Before we run anything I want you to report back and tell me exactly how everything is going to flow and finalize.

---

(Optional but recommended)

- Redirect check (lightweight)
  - If possible, do a HEAD/GET and follow redirects once:
  - Sometimes you get brand.co that always redirects to brand.com.
  - You can then store the final hostname instead.
