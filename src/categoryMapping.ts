/**
 * Maps IAB v3 taxonomy category paths to Savely's internal category slugs.
 *
 * IAB categories come from Klazify API in format like:
 * "/Food & Drink", "/Shopping/Consumer Electronics", etc.
 *
 * Our categories:
 * - food-dining
 * - retail-shopping
 * - entertainment
 * - travel-hotels
 * - home-garden
 * - electronics
 * - beauty-wellness
 * - fashion-apparel
 * - sports-fitness
 * - automotive
 * - office-supplies
 * - pet-supplies
 * - books-media
 * - toys-games
 * - other (fallback)
 */

type CategorySlug =
  | "food-dining"
  | "retail-shopping"
  | "entertainment"
  | "travel-hotels"
  | "home-garden"
  | "electronics"
  | "beauty-wellness"
  | "fashion-apparel"
  | "sports-fitness"
  | "automotive"
  | "office-supplies"
  | "pet-supplies"
  | "books-media"
  | "toys-games"
  | "other";

// Mapping rules from IAB category prefixes to our slugs.
// Order matters: more specific paths should come first.
const IAB_MAPPINGS: Array<{ pattern: RegExp; slug: CategorySlug }> = [
  // Food & Dining
  { pattern: /^\/Food & Drink/i, slug: "food-dining" },
  { pattern: /^\/Restaurants/i, slug: "food-dining" },
  { pattern: /^\/Grocery/i, slug: "food-dining" },

  // Electronics (before general Shopping)
  { pattern: /^\/Technology & Computing/i, slug: "electronics" },
  { pattern: /^\/Shopping\/Consumer Electronics/i, slug: "electronics" },
  { pattern: /^\/Electronics/i, slug: "electronics" },

  // Beauty & Wellness (before Fashion)
  { pattern: /^\/Style & Fashion\/Beauty/i, slug: "beauty-wellness" },
  { pattern: /^\/Health & Fitness\/Spa/i, slug: "beauty-wellness" },
  { pattern: /^\/Personal Care/i, slug: "beauty-wellness" },
  { pattern: /^\/Beauty/i, slug: "beauty-wellness" },
  { pattern: /^\/Cosmetics/i, slug: "beauty-wellness" },

  // Fashion & Apparel
  { pattern: /^\/Style & Fashion/i, slug: "fashion-apparel" },
  { pattern: /^\/Fashion/i, slug: "fashion-apparel" },
  { pattern: /^\/Apparel/i, slug: "fashion-apparel" },
  { pattern: /^\/Clothing/i, slug: "fashion-apparel" },
  { pattern: /^\/Shoes/i, slug: "fashion-apparel" },
  { pattern: /^\/Jewelry/i, slug: "fashion-apparel" },

  // Entertainment
  { pattern: /^\/Entertainment/i, slug: "entertainment" },
  { pattern: /^\/Movies/i, slug: "entertainment" },
  { pattern: /^\/Music/i, slug: "entertainment" },
  { pattern: /^\/Television/i, slug: "entertainment" },
  { pattern: /^\/Video Gaming/i, slug: "entertainment" },
  { pattern: /^\/Streaming/i, slug: "entertainment" },

  // Travel & Hotels
  { pattern: /^\/Travel/i, slug: "travel-hotels" },
  { pattern: /^\/Hotels/i, slug: "travel-hotels" },
  { pattern: /^\/Airlines/i, slug: "travel-hotels" },
  { pattern: /^\/Vacation/i, slug: "travel-hotels" },

  // Home & Garden
  { pattern: /^\/Home & Garden/i, slug: "home-garden" },
  { pattern: /^\/Home Improvement/i, slug: "home-garden" },
  { pattern: /^\/Furniture/i, slug: "home-garden" },
  { pattern: /^\/Interior Design/i, slug: "home-garden" },
  { pattern: /^\/Gardening/i, slug: "home-garden" },
  { pattern: /^\/Appliances/i, slug: "home-garden" },

  // Sports & Fitness
  { pattern: /^\/Sports/i, slug: "sports-fitness" },
  { pattern: /^\/Health & Fitness/i, slug: "sports-fitness" },
  { pattern: /^\/Fitness/i, slug: "sports-fitness" },
  { pattern: /^\/Outdoor/i, slug: "sports-fitness" },

  // Automotive
  { pattern: /^\/Automotive/i, slug: "automotive" },
  { pattern: /^\/Auto/i, slug: "automotive" },
  { pattern: /^\/Vehicles/i, slug: "automotive" },
  { pattern: /^\/Cars/i, slug: "automotive" },

  // Office Supplies
  { pattern: /^\/Office/i, slug: "office-supplies" },
  { pattern: /^\/Business\/Office/i, slug: "office-supplies" },
  { pattern: /^\/Stationery/i, slug: "office-supplies" },

  // Pet Supplies
  { pattern: /^\/Pets/i, slug: "pet-supplies" },
  { pattern: /^\/Pet/i, slug: "pet-supplies" },
  { pattern: /^\/Animals/i, slug: "pet-supplies" },

  // Books & Media
  { pattern: /^\/Books/i, slug: "books-media" },
  { pattern: /^\/News/i, slug: "books-media" },
  { pattern: /^\/Education/i, slug: "books-media" },
  { pattern: /^\/Reference/i, slug: "books-media" },
  { pattern: /^\/Magazines/i, slug: "books-media" },

  // Toys & Games
  { pattern: /^\/Toys/i, slug: "toys-games" },
  { pattern: /^\/Games/i, slug: "toys-games" },
  { pattern: /^\/Hobbies/i, slug: "toys-games" },

  // Retail & Shopping (general catch-all for shopping)
  { pattern: /^\/Shopping/i, slug: "retail-shopping" },
  { pattern: /^\/Retail/i, slug: "retail-shopping" },
  { pattern: /^\/E-Commerce/i, slug: "retail-shopping" },
  { pattern: /^\/Department Store/i, slug: "retail-shopping" },
];

/**
 * Maps an IAB taxonomy path to one of our category slugs.
 *
 * @param iabPath - The IAB category path from Klazify (e.g., "/Food & Drink/Restaurants")
 * @returns The matching category slug, or "other" if no match found
 */
export function mapIabToCategory(iabPath: string): CategorySlug {
  if (!iabPath || typeof iabPath !== "string") {
    return "other";
  }

  const normalized = iabPath.trim();
  if (!normalized) {
    return "other";
  }

  for (const { pattern, slug } of IAB_MAPPINGS) {
    if (pattern.test(normalized)) {
      return slug;
    }
  }

  return "other";
}

