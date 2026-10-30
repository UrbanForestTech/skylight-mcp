import { getClient, type SkylightClient } from "../client.js";
import type { CategoriesResponse, CategoryResource } from "../types.js";

// Categories (family members) cached per client: one Worker isolate serves
// many requests, so a module-wide cache could hand one household's members
// to another.
let categoriesCache = new WeakMap<SkylightClient, CategoryResource[]>();

/**
 * Get all categories (family members/profiles)
 */
export async function getCategories(useCache = true): Promise<CategoryResource[]> {
  const client = getClient();
  const cached = categoriesCache.get(client);
  if (useCache && cached) {
    return cached;
  }

  const response = await client.get<CategoriesResponse>("/api/frames/{frameId}/categories");
  categoriesCache.set(client, response.data);
  return response.data;
}

/**
 * Clear the categories cache
 */
export function clearCategoriesCache(): void {
  categoriesCache = new WeakMap();
}

/**
 * Find a category by name (case-insensitive partial match)
 * Categories represent family members like "Dad", "Mom", "Kids", etc.
 */
export async function findCategoryByName(name: string): Promise<CategoryResource | undefined> {
  const categories = await getCategories();
  const lowerName = name.toLowerCase();

  return categories.find((cat) => {
    const label = cat.attributes.label?.toLowerCase();
    return label && (label === lowerName || label.includes(lowerName));
  });
}

export type CategoryResolution =
  | { ok: true; category: CategoryResource }
  | { ok: false; error: string };

/**
 * Resolve a family member given as a category ID or a name. Strict where
 * findCategoryByName is loose: an ID or exact name wins, a partial name must
 * match exactly one member, and anything else fails with the choices listed.
 */
export async function resolveCategory(nameOrId: string): Promise<CategoryResolution> {
  const wanted = nameOrId.trim();
  const categories = await getCategories();
  const choices = () =>
    categories
      .filter((c) => c.attributes.label)
      .map((c) => `${c.attributes.label} (category ID: ${c.id})`)
      .join(", ");

  const byId = categories.find((c) => c.id === wanted);
  if (byId) return { ok: true, category: byId };

  const lower = wanted.toLowerCase();
  const exact = categories.filter((c) => c.attributes.label?.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, category: exact[0] };

  const partial = exact.length > 1 ? exact : categories.filter((c) => c.attributes.label?.toLowerCase().includes(lower));
  if (partial.length === 1) return { ok: true, category: partial[0] };

  if (partial.length > 1) {
    const names = partial.map((c) => `${c.attributes.label} (category ID: ${c.id})`).join(", ");
    return { ok: false, error: `"${wanted}" matches more than one family member: ${names}. Use the category ID.` };
  }
  return { ok: false, error: `No family member matches "${wanted}". Choose one of: ${choices() || "none found"}.` };
}

/**
 * Get categories that are linked to profiles (actual family members)
 */
export async function getFamilyMembers(): Promise<CategoryResource[]> {
  const categories = await getCategories();
  return categories.filter((cat) => cat.attributes.linked_to_profile);
}

/**
 * Get categories selected for the chore chart
 */
export async function getChoreChartCategories(): Promise<CategoryResource[]> {
  const categories = await getCategories();
  return categories.filter((cat) => cat.attributes.selected_for_chore_chart);
}
