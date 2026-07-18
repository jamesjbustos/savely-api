export interface GiftcardsPromo {
  code: string
  discountValue: number // percentage points added to the effective discount
  label: string
  expiration: string
}

// Flash Sale (July 18, 2026)
const FLASH_SALE_BRANDS = new Set([
  "adidas",
  "fanatics",
  "nintendo",
  "xbox",
  "petsmart",
  "petco",
  "the-container-store",
  "advance-auto-parts",
  "sunglass-hut",
  "shutterfly",
  "home-chef",
  "fandango",
  "oura",
  "topgolf",
  "finish-line",
  "dave-and-busters",
  "dave-busters",
  "main-event",
  "golfnow",
  "california-pizza-kitchen",
  "raising-canes",
  "raising-cane-s",
  "raising-cane",
  "cold-stone-creamery",
  "krispy-kreme",
  "lazy-dog",
  "lazy-dog-cafe",
  "omaha-steaks",
  "tommy-bahama",
  "columbia",
  "columbia-sportswear",
  "build-a-bear",
  "build-a-bear-workshop",
  "carters",
  "carter-s",
  "oshkosh-bgosh",
  "oshkosh",
  "the-childrens-place",
  "the-children-s-place",
  "primark",
  "talbots",
  "lands-end",
  "pacsun",
  "tillys",
  "tilly-s",
  "jcpenney",
  "belk",
  "bath-and-body-works",
  "bath-body-works",
  "kohls",
  "kohl-s",
  "lego",
])

// Back-to-School Sale (July 19 - July 23, 2026)
const BTS_BRANDS = new Set([
  "jcpenney",
  "michaels",
  "officemax",
  "office-depot",
  "the-container-store",
  "carters",
  "carter-s",
  "the-childrens-place",
  "the-children-s-place",
  "hm",
  "h-m",
  "h-and-m",
  "primark",
  "old-navy",
  "gap",
  "banana-republic",
  "american-eagle",
  "american-eagle-outfitters",
  "hollister",
  "hollister-co",
  "aeropostale",
  "adidas",
  "columbia",
  "columbia-sportswear",
  "smoothie-king",
  "panda-express",
  "jersey-mikes",
  "jersey-mike-s",
  "qdoba",
  "qdoba-mexican-eats",
  "mcalisters",
  "mcalister-s-deli",
  "first-watch",
])

// Daily Deals (July 20 - August 2, 2026)
const DAILY_DEALS: Record<string, string[]> = {
  "2026-07-20": ["chewy"],
  "2026-07-21": ["raising-canes", "raising-cane-s", "raising-cane"],
  "2026-07-22": ["the-childrens-place", "the-children-s-place"],
  "2026-07-23": ["smoothie-king"],
  "2026-07-24": ["pacsun"],
  "2026-07-25": ["panda-express"],
  "2026-07-26": ["spafinder", "spa-finder"],
  "2026-07-27": ["dominos", "domino-s"],
  "2026-07-28": ["moes", "moe-s-southwest-grill"],
  "2026-07-31": ["cinemark"],
  "2026-08-01": ["yankee-candle"],
  "2026-08-02": ["michaels"],
}

export function getEasternDateString(date: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    const parts = formatter.formatToParts(date)
    const month = parts.find((p) => p.type === "month")?.value
    const day = parts.find((p) => p.type === "day")?.value
    const year = parts.find((p) => p.type === "year")?.value
    return `${year}-${month}-${day}` // YYYY-MM-DD
  } catch {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
  }
}

// giftcards.com's product slugs are sometimes more specific than the email's
// short brand names (e.g. "raising-canes-chicken-fingers" vs "raising-canes",
// "carters-oshkosh-bgosh" vs "carters"). Match a set entry if the slug equals
// it or extends it at a hyphen boundary, so those still resolve. The boundary
// avoids partial-word hits ("belk" must not match "belkin").
function matchesBrand(slug: string, entries: Iterable<string>): boolean {
  for (const e of entries) {
    if (slug === e || slug.startsWith(`${e}-`)) return true
  }
  return false
}

export function getGiftcardsPromo(brandSlug: string, date: Date = new Date()): GiftcardsPromo | null {
  const dateStr = getEasternDateString(date)
  const slug = brandSlug.toLowerCase()

  // 1. Flash Sale: 2026-07-18 only
  if (dateStr === "2026-07-18") {
    if (matchesBrand(slug, FLASH_SALE_BRANDS)) {
      const code = matchesBrand(slug, ["bath-and-body-works", "bath-body-works"]) ? "STRIKE" : "FLASH"
      return {
        code,
        discountValue: 10,
        label: "Flash Sale",
        expiration: "Ends today",
      }
    }
  }

  // 2. Back-to-School Sale: 2026-07-19 to 2026-07-23
  if (dateStr >= "2026-07-19" && dateStr <= "2026-07-23") {
    if (matchesBrand(slug, DAILY_DEALS[dateStr] || [])) {
      return {
        code: "DAILYDEAL",
        discountValue: 10,
        label: "Daily Deal",
        expiration: "Ends today",
      }
    }

    if (matchesBrand(slug, BTS_BRANDS)) {
      return {
        code: "SCHOOL10",
        discountValue: 10,
        label: "Back-to-School Sale",
        expiration: dateStr === "2026-07-23" ? "Ends today" : "Ends July 23",
      }
    }
  }

  // 3. Daily Deals: 2026-07-20 to 2026-08-02
  if (matchesBrand(slug, DAILY_DEALS[dateStr] || [])) {
    return {
      code: "DAILYDEAL",
      discountValue: 10,
      label: "Daily Deal",
      expiration: "Ends today",
    }
  }

  return null
}
